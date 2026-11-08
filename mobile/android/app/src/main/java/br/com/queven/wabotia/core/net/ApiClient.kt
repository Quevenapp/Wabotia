package br.com.queven.wabotia.core.net

import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.model.ApiErrorBody
import br.com.queven.wabotia.core.model.WabotiaJson
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Erro devolvido pela API no formato {"error":{"code","message","request_id"}}. */
class ApiException(val status: Int, val code: String, override val message: String, val requestId: String? = null) : IOException(message) {
    val isUnauthorized get() = status == 401
    val isIdempotencyConflict get() = code == "idempotency_conflict"
    val isDefinitiveWriteRejection get() = status in 400..499 && status !in listOf(408, 429) && code !in listOf("operation_unknown", "idempotency_conflict")
}

/** Cliente HTTP para um servidor. Acrescenta Authorization: Bearer e traduz erros da API. */
class ApiClient(val baseUrl: String, private val tokenProvider: () -> String?) {
    val okHttp: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .addInterceptor(AuthInterceptor(tokenProvider))
        .addInterceptor(ErrorInterceptor())
        .apply {
            if (BuildConfig.DEBUG) addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        }
        .build()

    val api: WabotiaApi = Retrofit.Builder()
        .baseUrl("$baseUrl/")
        .client(okHttp)
        .addConverterFactory(WabotiaJson.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(WabotiaApi::class.java)

    /** URL absoluta para baixar/exibir um anexo privado (exige Authorization; use [okHttp]). */
    fun mediaUrl(profileId: String, mediaId: String, inline: Boolean = true) =
        "$baseUrl/api/v1/profiles/$profileId/media/$mediaId/content" + if (inline) "?inline=1" else ""

    private class AuthInterceptor(private val tokenProvider: () -> String?) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val token = tokenProvider()
            val request = chain.request().newBuilder()
                .header("Accept", "application/json")
                .header("User-Agent", "Wabotia-Android/${BuildConfig.VERSION_NAME}")
                .apply { if (!token.isNullOrBlank()) header("Authorization", "Bearer $token") }
                .build()
            return chain.proceed(request)
        }
    }

    private class ErrorInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val response = chain.proceed(chain.request())
            if (response.isSuccessful) return response
            val body = response.peekBody(64 * 1024).string()
            val parsed = runCatching { WabotiaJson.decodeFromString(ApiErrorBody.serializer(), body) }.getOrNull()?.error
            response.close()
            throw ApiException(
                status = response.code,
                code = parsed?.code ?: "http_${response.code}",
                message = parsed?.message ?: when (response.code) {
                    401 -> "Sessão expirada. Entre novamente."
                    403 -> "Sem permissão para esta ação."
                    404 -> "Recurso não encontrado."
                    429 -> "Muitas requisições. Aguarde um instante."
                    else -> "Não foi possível concluir a operação (HTTP ${response.code})."
                },
                requestId = parsed?.request_id,
            )
        }
    }

    companion object {
        fun newIdempotencyKey(): String = UUID.randomUUID().toString()

        /** Mensagem amigável para qualquer exceção de rede/API. */
        fun describe(e: Throwable): String = when (e) {
            is ApiException -> e.message
            is HttpException -> "Erro HTTP ${e.code()}"
            is java.net.UnknownHostException -> "Servidor não encontrado. Confira o endereço e a conexão."
            is java.net.SocketTimeoutException -> "O servidor demorou a responder."
            is javax.net.ssl.SSLException -> "Falha de certificado HTTPS no servidor."
            is IOException -> "Falha de rede. Verifique sua conexão."
            else -> e.message ?: "Erro inesperado."
        }
    }
}
