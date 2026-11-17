package dev.doublepi.cox.mobile

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

internal class DownloadDestination(private val context: Context, suggestedName: String) : Closeable {
    private val name = suggestedName.replace(Regex("[\\\\/\\p{Cntrl}]"), "_")
        .replace("..", "_").take(180).trim().ifEmpty { "download" }
    private val uri = if (Build.VERSION.SDK_INT >= 29) {
        context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Cox")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }) ?: throw IOException("Cannot create download")
    } else null
    private val file = if (uri == null) {
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IOException("Downloads storage is unavailable")
        File(directory, ".${UUID.randomUUID()}.part")
    } else null
    val output: OutputStream = try {
        if (uri != null) context.contentResolver.openOutputStream(uri) ?: throw IOException("Cannot open download")
        else requireNotNull(file).outputStream()
    } catch (error: Exception) {
        uri?.let { context.contentResolver.delete(it, null, null) }
        throw error
    }
    private var published = false

    fun publish() {
        output.close()
        if (uri != null && Build.VERSION.SDK_INT >= 29) {
            check(context.contentResolver.update(uri, ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }, null, null) == 1)
        } else {
            val partial = requireNotNull(file)
            val destination = File(partial.parentFile, "${UUID.randomUUID()}-$name")
            check(partial.renameTo(destination)) { "Cannot publish download" }
        }
        published = true
    }

    override fun close() {
        try { output.close() } finally {
            if (!published) {
                uri?.let { context.contentResolver.delete(it, null, null) }
                file?.delete()
            }
        }
    }
}
