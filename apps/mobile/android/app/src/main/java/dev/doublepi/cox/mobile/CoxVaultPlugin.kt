package dev.doublepi.cox.mobile

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

@CapacitorPlugin(name = "CoxVault")
class CoxVaultPlugin : Plugin() {
    private val active = mutableSetOf<String>()
    private val metadata by lazy { context.getSharedPreferences("cox_vault_bindings", Context.MODE_PRIVATE) }
    private val secrets by lazy {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "cox_vault", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    private data class Binding(val id: String, val origin: String)

    private fun identity(call: PluginCall): String {
        val page = URI(bridge.webView.url ?: "")
        require(page.scheme == "https" && page.host == "localhost")
        val id = requireNotNull(call.getString("profileId"))
        require(UUID.fromString(id).toString() == id && id !in active)
        return id
    }

    private fun binding(call: PluginCall): Binding {
        val id = identity(call)
        val raw = requireNotNull(call.getString("canonicalOrigin"))
        val uri = URI(raw)
        require(uri.scheme == "https" || uri.scheme == "http")
        require(uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null)
        require(uri.rawFragment == null && uri.rawPath.isEmpty() && uri.toASCIIString() == raw)
        return Binding(id, raw)
    }

    @PluginMethod
    fun savePassword(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val target = binding(call)
                val password = requireNotNull(call.getString("password"))
                val biometric = requireNotNull(call.getBoolean("requireBiometric"))
                require(password.isNotEmpty())
                if (biometric) require(BiometricManager.from(context).canAuthenticate(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG
                ) == BiometricManager.BIOMETRIC_SUCCESS)
                val stored = JSONObject().put("canonicalOrigin", target.origin).put("password", password)
                    .put("requireBiometric", biometric)
                check(secrets.edit().putString(target.id, stored.toString()).commit())
                check(metadata.edit().putString(target.id, target.origin)
                    .putBoolean("${target.id}:biometric", biometric).commit())
                call.resolve()
            } catch (error: Exception) {
                call.reject("The credential could not be saved.", "vault_unavailable")
            }
        }
    }

    @PluginMethod
    fun unlockAndAutofillPassword(call: PluginCall) {
        activity.runOnUiThread {
            var reservedId: String? = null
            try {
                require(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                val target = binding(call)
                require(target.origin.startsWith("https://") || call.getBoolean("allowInsecureHttp") == true)
                require(metadata.getString(target.id, null) == target.origin)
                val digest = MessageDigest.getInstance("SHA-256").digest(target.origin.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it.toInt() and 255) }.take(16)
                val expectedName = "cox_srv_${target.id.lowercase().replace("-", "")}_$digest"
                val profileName = call.getString("androidProfileName") ?: expectedName
                require(profileName == expectedName)
                active.add(target.id)
                reservedId = target.id
                if (metadata.getBoolean("${target.id}:biometric", true)) {
                    val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(context),
                        object : BiometricPrompt.AuthenticationCallback() {
                            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                                establishSession(call, target, profileName)
                            }
                            override fun onAuthenticationError(code: Int, message: CharSequence) {
                                active.remove(target.id)
                                call.reject("Credential unlock was cancelled.", "vault_unavailable")
                            }
                        })
                    prompt.authenticate(BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Cox server password")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                        .setNegativeButtonText("Cancel").build())
                } else {
                    establishSession(call, target, profileName)
                }
            } catch (error: Exception) {
                reservedId?.let { active.remove(it) }
                call.reject("The credential could not be unlocked.", "vault_unavailable")
            }
        }
    }

    private fun establishSession(call: PluginCall, target: Binding, profileName: String) {
        execute {
            try {
                val stored = JSONObject(requireNotNull(secrets.getString(target.id, null)))
                require(stored.getString("canonicalOrigin") == target.origin)
                require(stored.getBoolean("requireBiometric") == metadata.getBoolean("${target.id}:biometric", true))
                val connection = URI("${target.origin}/api/auth/browser-session").toURL().openConnection()
                require(connection is HttpURLConnection)
                val cookies = try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 20_000
                    connection.readTimeout = 20_000
                    connection.requestMethod = "POST"
                    connection.setRequestProperty("Origin", target.origin)
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.doOutput = true
                    val body = JSONObject().put("credential", stored.getString("password")).toString()
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    check(connection.responseCode in 200..299)
                    connection.headerFields.entries.filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                        .flatMap { it.value }
                } finally { connection.disconnect() }
                require(cookies.isNotEmpty())
                activity.runOnUiThread {
                    try {
                        val manager = ProfileStore.getInstance().getOrCreateProfile(profileName).cookieManager
                        var remaining = cookies.size
                        var accepted = true
                        cookies.forEach { cookie ->
                            manager.setCookie(target.origin, cookie) { success ->
                                accepted = accepted && success
                                remaining -= 1
                                if (remaining == 0) {
                                    manager.flush()
                                    active.remove(target.id)
                                    if (accepted) call.resolve()
                                    else call.reject("The session cookie was rejected.", "vault_unavailable")
                                }
                            }
                        }
                    } catch (error: Exception) {
                        active.remove(target.id)
                        call.reject("The session could not be opened.", "vault_unavailable")
                    }
                }
            } catch (error: Exception) {
                activity.runOnUiThread {
                    active.remove(target.id)
                    call.reject("The session could not be opened.", "vault_unavailable")
                }
            }
        }
    }

    @PluginMethod
    fun deletePassword(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val id = identity(call)
                check(secrets.edit().remove(id).commit())
                check(metadata.edit().remove(id).remove("$id:biometric").commit())
                call.resolve()
            } catch (error: Exception) {
                call.reject("The credential could not be removed.", "vault_unavailable")
            }
        }
    }
}
