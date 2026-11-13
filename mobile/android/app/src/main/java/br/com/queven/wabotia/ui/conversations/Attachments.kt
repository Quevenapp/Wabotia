@file:OptIn(ExperimentalMaterial3Api::class)
// Media3 marca as APIs instáveis com @RequiresOptIn do androidx.annotation; o OptIn do Kotlin não vale para elas.
@file:androidx.annotation.OptIn(UnstableApi::class)

package br.com.queven.wabotia.ui.conversations

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.media.AuthenticatedMedia
import br.com.queven.wabotia.core.media.MediaDownloader
import br.com.queven.wabotia.core.media.MediaKinds
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.ui.components.formatClock
import br.com.queven.wabotia.ui.components.handleError
import br.com.queven.wabotia.ui.theme.Wb
import coil.compose.AsyncImage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import kotlin.math.absoluteValue

/**
 * ExoPlayer que fala com o servidor pelo OkHttp autenticado (Authorization) e continua lendo
 * arquivos locais (file:// e content://) pelo DefaultDataSource, usado nas prévias de gravação.
 */
internal fun buildPlayer(context: Context, okHttp: OkHttpClient): ExoPlayer {
    val http = OkHttpDataSource.Factory(okHttp)
    val dataSource = DefaultDataSource.Factory(context, http)
    return ExoPlayer.Builder(context)
        .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
        .build()
}

private val imageMimes = setOf("image/jpeg", "image/png", "image/webp", "image/gif")

internal fun MediaFile.isImage(): Boolean = MediaKinds.baseMime(type) in imageMimes

/** Escolhe a visualização conforme o tipo do anexo (lista `media` do detalhe da conversa). */
@Composable
internal fun AttachmentView(
    media: MediaFile,
    voice: Boolean,
    profileId: String,
    container: AppContainer,
    width: Dp,
    accent: Color,
    onOpenImage: (MediaFile) -> Unit,
    modifier: Modifier = Modifier,
) {
    val base = MediaKinds.baseMime(media.type)
    when {
        base in imageMimes -> ImageAttachment(media, profileId, container, width, onOpenImage, modifier)
        base.startsWith("video/") -> VideoAttachment(media, profileId, container, width, modifier)
        base.startsWith("audio/") -> Column(modifier.width(width)) {
            AudioPlayerBar(
                uri = AuthenticatedMedia.url(container, profileId, media.id, inline = true),
                container = container,
                seed = media.id,
                voice = voice,
                accent = accent,
            )
            if (!voice && media.name.isNotBlank() && !media.name.startsWith("voz-") && media.name != "mensagem-de-voz.ogg") {
                Text(
                    "${media.name} · ${MediaKinds.formatSize(media.size)}",
                    fontSize = 11.5.sp,
                    color = Wb.colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 8.dp, end = 8.dp, bottom = 2.dp),
                )
            }
        }
        else -> DocumentAttachment(media, profileId, container, width, modifier)
    }
}

@Composable
private fun ImageAttachment(media: MediaFile, profileId: String, container: AppContainer, width: Dp, onOpenImage: (MediaFile) -> Unit, modifier: Modifier) {
    val url = AuthenticatedMedia.url(container, profileId, media.id, inline = true)
    AsyncImage(
        model = url,
        contentDescription = media.name.ifBlank { "Imagem" },
        imageLoader = AuthenticatedMedia.imageLoader(container),
        modifier = modifier
            .width(width)
            .aspectRatio(1.25f)
            .clip(RoundedCornerShape(10.dp))
            .background(Wb.colors.textSecondary.copy(alpha = 0.18f))
            .clickable { onOpenImage(media) },
        contentScale = ContentScale.Crop,
    )
}

@Composable
private fun VideoAttachment(media: MediaFile, profileId: String, container: AppContainer, width: Dp, modifier: Modifier) {
    val context = LocalContext.current
    val url = AuthenticatedMedia.url(container, profileId, media.id, inline = true)
    var player by remember(media.id) { mutableStateOf<ExoPlayer?>(null) }
    DisposableEffect(media.id) {
        onDispose {
            player?.release()
            player = null
        }
    }
    Box(
        modifier
            .width(width)
            .aspectRatio(1.25f)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        val current = player
        if (current == null) {
            Box(
                Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.45f))
                    .clickable {
                        val created = buildPlayer(context, container.okHttp)
                        created.setMediaItem(MediaItem.fromUri(url))
                        created.prepare()
                        created.playWhenReady = true
                        player = created
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.PlayArrow, contentDescription = "Reproduzir vídeo", tint = Color.White, modifier = Modifier.size(36.dp))
            }
            Row(
                Modifier.align(Alignment.BottomStart).padding(8.dp).clip(RoundedCornerShape(6.dp)).background(Color.Black.copy(alpha = 0.5f)).padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Videocam, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(MediaKinds.formatSize(media.size), color = Color.White, fontSize = 11.5.sp, maxLines = 1)
            }
        } else {
            AndroidView(
                factory = { ctx ->
                    val view = PlayerView(ctx)
                    view.player = current
                    view.useController = true
                    view
                },
                update = { view -> view.player = current },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

private val speeds = listOf(1f, 1.5f, 2f)

/**
 * Player de áudio/voz: play, onda com progresso (toque para avançar), duração e velocidade (1x / 1,5x / 2x).
 * Funciona com URLs do servidor (OkHttp autenticado) e com arquivos locais (prévia da gravação).
 */
@Composable
internal fun AudioPlayerBar(
    uri: String,
    container: AppContainer,
    modifier: Modifier = Modifier,
    seed: String = uri,
    voice: Boolean = true,
    accent: Color = Wb.colors.brand,
) {
    val context = LocalContext.current
    val c = Wb.colors
    var player by remember(uri) { mutableStateOf<ExoPlayer?>(null) }
    var playing by remember(uri) { mutableStateOf(false) }
    var buffering by remember(uri) { mutableStateOf(false) }
    var failed by remember(uri) { mutableStateOf(false) }
    var positionMs by remember(uri) { mutableLongStateOf(0L) }
    var durationMs by remember(uri) { mutableLongStateOf(0L) }
    var speedIndex by remember(uri) { mutableIntStateOf(0) }

    DisposableEffect(uri) {
        onDispose {
            player?.release()
            player = null
        }
    }
    LaunchedEffect(playing) {
        while (playing) {
            val current = player
            if (current != null) {
                positionMs = current.currentPosition
                val d = current.duration
                if (d > 0) durationMs = d
            }
            delay(120)
        }
    }

    fun ensurePlayer(): ExoPlayer {
        player?.let { return it }
        val created = buildPlayer(context, container.okHttp)
        created.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING
                if (playbackState == Player.STATE_READY) {
                    val d = created.duration
                    if (d > 0) durationMs = d
                }
                if (playbackState == Player.STATE_ENDED) {
                    created.pause()
                    created.seekTo(0)
                    positionMs = 0
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                failed = true
                buffering = false
            }
        })
        created.setMediaItem(MediaItem.fromUri(uri))
        created.setPlaybackSpeed(speeds[speedIndex])
        created.prepare()
        player = created
        return created
    }

    val bars = remember(seed) { waveform(seed, 34) }
    val fraction = if (durationMs > 0) (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f) else 0f

    Row(modifier.fillMaxWidth().height(52.dp).padding(start = 2.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(44.dp)
                .clip(CircleShape)
                .clickable {
                    failed = false
                    val p = ensurePlayer()
                    if (p.isPlaying) p.pause() else p.play()
                },
            contentAlignment = Alignment.Center,
        ) {
            if (buffering && !playing) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = accent)
            } else {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "Pausar" else "Reproduzir áudio",
                    tint = accent,
                    modifier = Modifier.size(32.dp),
                )
            }
        }
        Column(Modifier.weight(1f).padding(start = 2.dp)) {
            val idle = c.textSecondary.copy(alpha = 0.45f)
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(26.dp)
                    .pointerInput(uri) {
                        detectTapGestures { offset ->
                            val p = ensurePlayer()
                            val target = ((offset.x / size.width).coerceIn(0f, 1f) * (if (durationMs > 0) durationMs else p.duration.coerceAtLeast(0))).toLong()
                            positionMs = target
                            p.seekTo(target)
                        }
                    },
            ) {
                val gap = 2.dp.toPx()
                val barWidth = ((size.width - gap * (bars.size - 1)) / bars.size).coerceAtLeast(1f)
                bars.forEachIndexed { index, level ->
                    val h = (size.height * level).coerceAtLeast(3.dp.toPx())
                    val x = index * (barWidth + gap)
                    val played = (index + 0.5f) / bars.size <= fraction
                    drawRoundRect(
                        color = if (played) accent else idle,
                        topLeft = Offset(x, (size.height - h) / 2),
                        size = Size(barWidth, h),
                        cornerRadius = CornerRadius(barWidth / 2),
                    )
                }
            }
            Text(
                when {
                    failed -> "Não foi possível tocar"
                    playing || positionMs > 0 -> formatClock(positionMs)
                    durationMs > 0 -> formatClock(durationMs)
                    else -> if (voice) "Mensagem de voz" else "Áudio"
                },
                color = if (failed) c.danger else c.textSecondary,
                fontSize = 11.sp,
                maxLines = 1,
            )
        }
        Spacer(Modifier.width(6.dp))
        if (playing || positionMs > 0) {
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(c.textSecondary.copy(alpha = 0.22f))
                    .clickable {
                        speedIndex = (speedIndex + 1) % speeds.size
                        player?.setPlaybackSpeed(speeds[speedIndex])
                    }
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    when (speedIndex) { 1 -> "1,5x"; 2 -> "2x"; else -> "1x" },
                    color = c.textPrimary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

/** Onda estável por anexo (o servidor não envia a forma de onda): níveis derivados do id. */
private fun waveform(seed: String, count: Int): List<Float> {
    var state = seed.hashCode().toLong().absoluteValue + 17
    return List(count) { index ->
        state = (state * 6364136223846793005L + 1442695040888963407L)
        val random = ((state ushr 33).toInt().absoluteValue % 1000) / 1000f
        val envelope = 0.55f + 0.45f * kotlin.math.sin(index / count.toFloat() * Math.PI).toFloat()
        (0.22f + 0.78f * random) * envelope
    }
}

private fun documentVisual(mime: String, name: String): Pair<ImageVector, String> {
    val base = MediaKinds.baseMime(mime)
    val ext = name.substringAfterLast('.', "").lowercase()
    return when {
        base == "application/pdf" || ext == "pdf" -> Icons.Filled.PictureAsPdf to "PDF"
        "sheet" in base || "excel" in base || base == "text/csv" || ext in setOf("xls", "xlsx", "csv") -> Icons.Filled.TableChart to (ext.ifBlank { "planilha" }).uppercase()
        else -> Icons.AutoMirrored.Filled.InsertDriveFile to (ext.ifBlank { base.substringAfter('/') }).uppercase().take(6)
    }
}

/** Documento: ícone por tipo, nome, tamanho, baixar/abrir e compartilhar (baixa para o cache com Authorization). */
@Composable
private fun DocumentAttachment(media: MediaFile, profileId: String, container: AppContainer, width: Dp, modifier: Modifier) {
    val context = LocalContext.current
    val c = Wb.colors
    val scope = rememberCoroutineScope()
    val downloader = remember(container) { MediaDownloader(container) }
    var busy by remember { mutableStateOf(false) }
    var percent by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }

    fun run(action: (java.io.File) -> Boolean, failure: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val file = downloader.download(profileId, media) { percent = it }
                if (!action(file)) error = failure
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = container.handleError(e)
            } finally {
                busy = false
            }
        }
    }

    val (icon, typeLabel) = remember(media.type, media.name) { documentVisual(media.type, media.name) }
    val tint = when (icon) {
        Icons.Filled.PictureAsPdf -> c.danger
        Icons.Filled.TableChart -> c.ok
        else -> c.ticket
    }
    Column(
        modifier
            .width(width)
            .clip(RoundedCornerShape(10.dp))
            .background(if (c.isDark) Color.White.copy(alpha = 0.06f) else Color.Black.copy(alpha = 0.04f))
            .clickable(enabled = !busy) { run({ downloader.open(context, it, media.type) }, "Nenhum aplicativo consegue abrir este arquivo. Use Compartilhar.") },
    ) {
        Row(Modifier.padding(start = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(media.name.ifBlank { "Anexo" }, color = c.textPrimary, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp)
                Text(
                    listOfNotNull(typeLabel.takeIf { it.isNotBlank() }, MediaKinds.formatSize(media.size).takeIf { media.size > 0 }).joinToString(" · "),
                    color = c.textSecondary,
                    fontSize = 12.sp,
                    maxLines = 1,
                )
            }
            if (busy) {
                Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(progress = { percent / 100f }, modifier = Modifier.size(24.dp), strokeWidth = 2.5.dp, color = c.brand)
                }
            } else {
                IconButton(onClick = { run({ downloader.open(context, it, media.type) }, "Nenhum aplicativo consegue abrir este arquivo. Use Compartilhar.") }, modifier = Modifier.size(40.dp)) {
                    Icon(Icons.Filled.Download, contentDescription = "Baixar e abrir documento", tint = c.textSecondary, modifier = Modifier.size(22.dp))
                }
            }
            IconButton(
                onClick = { run({ downloader.share(context, it, media.type, "Compartilhar ${media.name}") }, "Não foi possível compartilhar o arquivo.") },
                enabled = !busy,
                modifier = Modifier.size(40.dp),
            ) { Icon(Icons.Filled.Share, contentDescription = "Compartilhar documento", tint = c.textSecondary, modifier = Modifier.size(20.dp)) }
        }
        error?.let {
            Text(it, color = c.danger, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp, end = 8.dp, bottom = 6.dp))
        }
    }
}

/** Visualizador de imagem em tela cheia com zoom (pinça) e compartilhamento. */
@Composable
internal fun ImageViewerDialog(media: MediaFile, profileId: String, container: AppContainer, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val downloader = remember(container) { MediaDownloader(container) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var sharing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val transformState = rememberTransformableState { zoom, pan, _ ->
        scale = (scale * zoom).coerceIn(1f, 6f)
        offset = if (scale <= 1f) Offset.Zero else offset + pan
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AsyncImage(
                model = AuthenticatedMedia.url(container, profileId, media.id, inline = true),
                contentDescription = media.name.ifBlank { "Imagem" },
                imageLoader = AuthenticatedMedia.imageLoader(container),
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .transformable(transformState)
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
            Row(
                Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.45f)).statusBarsPadding().padding(4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = "Fechar", tint = Color.White) }
                Text(
                    media.name,
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                )
                IconButton(
                    onClick = {
                        if (sharing) return@IconButton
                        sharing = true
                        error = null
                        scope.launch {
                            try {
                                val file = downloader.download(profileId, media)
                                if (!downloader.share(context, file, media.type, "Compartilhar imagem")) error = "Não foi possível compartilhar."
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = container.handleError(e)
                            } finally {
                                sharing = false
                            }
                        }
                    },
                ) {
                    if (sharing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
                    else Icon(Icons.Filled.Share, contentDescription = "Compartilhar imagem", tint = Color.White)
                }
            }
            error?.let {
                Text(it, color = Color.White, style = MaterialTheme.typography.bodySmall, modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp))
            }
        }
    }
}
