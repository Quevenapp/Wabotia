package br.com.queven.wabotia.core.media

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.net.Uri
import android.provider.ContactsContract
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Leitura de dados do aparelho usados pelo composer: posição atual e contato da agenda. */
object DeviceInputs {
    fun hasPermission(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun hasLocationPermission(context: Context): Boolean =
        hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** Posição atual via FusedLocationProviderClient; exige permissão concedida antes da chamada. */
    @SuppressLint("MissingPermission")
    suspend fun currentLocation(context: Context, timeoutMs: Long = 15_000): Location? {
        if (!hasLocationPermission(context)) return null
        val client = LocationServices.getFusedLocationProviderClient(context)
        val priority = if (hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        return try {
            val tokenSource = CancellationTokenSource()
            withTimeoutOrNull(timeoutMs) { client.getCurrentLocation(priority, tokenSource.token).await() }
                ?: runCatching { client.lastLocation.await() }.getOrNull()
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Nome e telefone (somente dígitos, com "+" opcional) do número escolhido em [PickContactPhone]. O seletor do sistema
     * concede leitura temporária só daquela linha, por isso o app não pede READ_CONTACTS.
     */
    suspend fun readContact(context: Context, uri: Uri): Pair<String, String>? = withContext(Dispatchers.IO) {
        runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) Pair(cursor.getString(0).orEmpty().trim(), normalizePhone(cursor.getString(1).orEmpty())) else null
            }
        }.getOrNull()
    }

    /** Mantém "+" inicial e dígitos, no formato aceito pelo servidor (^\+?\d{8,16}$). */
    fun normalizePhone(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return if (raw.trim().startsWith("+")) "+$digits" else digits
    }
}

/**
 * Abre o seletor de contatos do sistema na lista de telefones (ACTION_PICK em Phone.CONTENT_URI) e devolve a URI do
 * número escolhido, com permissão de leitura temporária para aquela linha; dispensa READ_CONTACTS.
 */
class PickContactPhone : ActivityResultContract<Unit, Uri?>() {
    override fun createIntent(context: Context, input: Unit): Intent =
        Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        intent?.takeIf { resultCode == android.app.Activity.RESULT_OK }?.data
}
