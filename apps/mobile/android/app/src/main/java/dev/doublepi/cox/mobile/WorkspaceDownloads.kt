package dev.doublepi.cox.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class WorkspaceDownloads(private val context: Context) {
    private val worker = Executors.newSingleThreadExecutor()
    private val retired = ConcurrentHashMap.newKeySet<String>()
    private val main = Handler(Looper.getMainLooper())

    fun retire(profileName: String, completion: () -> Unit) {
        retired.add(profileName)
        worker.execute { main.post { completion() } }
    }

    fun close() { worker.shutdown() }

    fun download(binding: DownloadBinding, url: String, suggestedName: String) {
        execute(binding.identity) {
            var hop = DownloadHop(url, canonicalOrigin(url) == binding.identity.origin)
            repeat(6) { index ->
                checkActive(binding.identity)
                require(binding.identity.permits(hop.url)) { "Download transport is blocked" }
                val connection = URL(hop.url).openConnection() as HttpURLConnection
                try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 15_000
                    if (hop.cookiesAllowed) {
                        binding.cookies.getCookie(hop.url)?.let { connection.setRequestProperty("Cookie", it) }
                    }
                    val status = connection.responseCode
                    if (status in listOf(301, 302, 303, 307, 308)) {
                        require(index < 5) { "Too many download redirects" }
                        val location = connection.getHeaderField("Location") ?: throw IOException("Missing download redirect")
                        hop = hop.redirect(binding.identity, location) ?: throw IOException("Download redirect is blocked")
                    } else {
                        require(status in 200..299) { "Download returned HTTP $status" }
                        val name = URLUtil.guessFileName(hop.url, connection.getHeaderField("Content-Disposition"), connection.contentType)
                        connection.inputStream.use { stream ->
                            save(binding.identity, stream, if (suggestedName.isBlank()) name else suggestedName)
                        }
                        return@execute
                    }
                } finally {
                    connection.disconnect()
                }
            }
        }
    }

    fun saveBlob(identity: WorkspaceIdentity, data: String, filename: String) {
        require(data.length <= ((MAX_BYTES + 2) / 3) * 4 + 4096) { "Download exceeds 16 MiB" }
        execute(identity) {
            val comma = data.indexOf(',')
            require(data.startsWith("data:") && comma in 5..4096) { "Invalid data URL" }
            val header = data.substring(0, comma)
            val payload = data.substring(comma + 1)
            val bytes = if (header.endsWith(";base64")) {
                val padding = if (payload.endsWith("==")) 2 else if (payload.endsWith("=")) 1 else 0
                require(payload.length % 4 == 0 && payload.indices.all { index ->
                    val char = payload[index]
                    if (index >= payload.length - padding) char == '='
                    else char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char == '+' || char == '/'
                })
                Base64.decode(payload, Base64.NO_WRAP)
            } else {
                java.net.URLDecoder.decode(payload.replace("+", "%2B"), "UTF-8").toByteArray(Charsets.UTF_8)
            }
            require(bytes.size <= MAX_BYTES) { "Download exceeds 16 MiB" }
            ByteArrayInputStream(bytes).use { save(identity, it, filename) }
        }
    }

    private fun save(identity: WorkspaceIdentity, stream: InputStream, filename: String) {
        DownloadDestination(context, filename).use { destination ->
            val buffer = ByteArray(32 * 1024)
            var total = 0
            while (true) {
                checkActive(identity)
                val size = stream.read(buffer)
                if (size == -1) break
                total += size
                require(total <= MAX_BYTES) { "Download exceeds 16 MiB" }
                destination.output.write(buffer, 0, size)
            }
            checkActive(identity)
            destination.publish()
        }
    }

    private fun checkActive(identity: WorkspaceIdentity) {
        check(identity.profileName !in retired) { "Server was forgotten" }
    }

    private fun execute(identity: WorkspaceIdentity, operation: () -> Unit) {
        if (identity.profileName in retired) return
        worker.execute {
            val message = try {
                checkActive(identity)
                operation()
                "Download saved"
            } catch (error: Exception) {
                android.util.Log.w("CoxMobile", "Workspace download failed: ${error.javaClass.simpleName}")
                "Download could not be saved"
            }
            main.post { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
        }
    }

    companion object { const val MAX_BYTES = 16 * 1024 * 1024 }
}

internal data class DownloadBinding(val identity: WorkspaceIdentity, val cookies: CookieManager)
