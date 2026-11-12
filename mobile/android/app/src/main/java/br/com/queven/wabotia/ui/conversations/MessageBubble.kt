@file:OptIn(ExperimentalFoundationApi::class)

package br.com.queven.wabotia.ui.conversations

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Shortcut
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.ConversationDetail
import br.com.queven.wabotia.core.model.Delivery
import br.com.queven.wabotia.core.model.MediaFile
import br.com.queven.wabotia.core.model.Message
import br.com.queven.wabotia.core.model.TeamContact
import br.com.queven.wabotia.core.model.array
import br.com.queven.wabotia.core.model.bool
import br.com.queven.wabotia.core.model.double
import br.com.queven.wabotia.core.model.obj
import br.com.queven.wabotia.core.model.string
import br.com.queven.wabotia.ui.components.Avatar
import br.com.queven.wabotia.ui.components.TailWidth
import br.com.queven.wabotia.ui.components.bubbleBackground
import br.com.queven.wabotia.ui.components.avatarColor
import br.com.queven.wabotia.ui.components.formatPhone
import br.com.queven.wabotia.ui.components.formatTime
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.util.Locale
import kotlin.math.roundToInt

internal class BubbleContext(
    val detail: ConversationDetail,
    val meId: String?,
    val team: Map<String, TeamContact>,
    val mediaById: Map<String, MediaFile>,
    val container: AppContainer,
    val profileId: String,
    val maxWidth: Dp,
    val canSwipeReply: Boolean,
)

/**
 * Bolha de mensagem (DESIGN.md §5): cliente à esquerda, enviadas à direita, nota interna à direita em `bubbleNote`.
 * Mostra etiqueta de autor (bot, outro atendente, participante do grupo), citação, mídia, texto, localização, contato,
 * reações sobrepostas e, dentro da bolha no canto inferior direito, horário, "Editada" e ticks.
 */
@Composable
internal fun MessageBubble(
    message: Message,
    ctx: BubbleContext,
    first: Boolean,
    highlighted: Boolean,
    quotedText: String?,
    quotedAuthor: String?,
    onLongPress: () -> Unit,
    onOpenImage: (MediaFile) -> Unit,
    onQuoteClick: () -> Unit,
    onFailedClick: () -> Unit,
    onSwipeReply: () -> Unit,
) {
    val c = Wb.colors
    val content = remember(message.content) { message.contentJson }
    val deleted = content.bool("deleted") == true
    val note = message.isNote
    val outgoing = !message.isIncoming
    val bubbleColor = when {
        note -> c.bubbleNote
        outgoing -> c.bubbleOut
        else -> c.bubbleIn
    }
    val subtle = if (outgoing && !note) c.bubbleOutMeta else c.textSecondary
    val reactions = remember(message.content) {
        content.obj("reactions")?.values?.mapNotNull { (it as? JsonObject)?.string("emoji")?.takeIf { e -> e.isNotBlank() } }.orEmpty()
    }
    val attachments = if (deleted) emptyList() else message.attachmentIds.map { id ->
        ctx.mediaById[id] ?: MediaFile(id = id, name = "Anexo", type = "application/octet-stream", size = 0)
    }
    val hasQuote = content.string("reply_to") != null || content.string("reply_external_id") != null
    val label = authorLabel(message, ctx, content)
    val edited = content.bool("edited") == true
    val showTick = outgoing && !note && message.delivery_status.isNotBlank()
    val failed = showTick && message.delivery_status == "failed"

    // Deslizar a bolha para a direita = responder.
    val scope = rememberCoroutineScope()
    val drag = remember { Animatable(0f) }
    val swipeModifier = if (ctx.canSwipeReply && !note && !deleted && message.external_id != null) {
        Modifier.pointerInput(message.id) {
            val limit = 72.dp.toPx()
            detectHorizontalDragGestures(
                onDragEnd = {
                    if (drag.value > limit * 0.7f) onSwipeReply()
                    scope.launch { drag.animateTo(0f) }
                },
                onDragCancel = { scope.launch { drag.animateTo(0f) } },
            ) { change, amount ->
                val next = (drag.value + amount).coerceIn(0f, limit)
                if (next != drag.value) {
                    change.consume()
                    scope.launch { drag.snapTo(next) }
                }
            }
        }
    } else Modifier

    Box(
        Modifier
            .fillMaxWidth()
            .padding(top = if (first) 6.dp else 2.dp, bottom = if (reactions.isNotEmpty()) 19.dp else 0.dp)
            .then(swipeModifier),
        contentAlignment = if (outgoing) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        if (drag.value > 4f) {
            Icon(
                Icons.AutoMirrored.Filled.Reply,
                contentDescription = null,
                tint = c.textSecondary,
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 8.dp).size(22.dp),
            )
        }
        Box(Modifier.offset { IntOffset(drag.value.roundToInt(), 0) }) {
            Column(
                Modifier
                    .widthIn(min = 84.dp, max = ctx.maxWidth)
                    .width(IntrinsicSize.Max)
                    .bubbleBackground(bubbleColor, outgoing, first, if (highlighted) c.brand.copy(alpha = 0.22f) else null)
                    .combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                        onLongClick = onLongPress,
                        onLongClickLabel = "Ações da mensagem",
                    )
                    .padding(start = if (outgoing) 0.dp else TailWidth, end = if (outgoing) TailWidth else 0.dp)
                    .padding(3.dp),
            ) {
                if (label != null) {
                    Row(Modifier.padding(start = 6.dp, end = 6.dp, top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (label.icon != null) {
                            Icon(label.icon, contentDescription = null, tint = label.color, modifier = Modifier.size(13.dp))
                            Spacer(Modifier.width(4.dp))
                        }
                        Text(label.text, color = label.color, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (hasQuote) {
                    QuoteBlock(
                        accent = if (outgoing && !note) c.bubbleOutAccent else c.brand,
                        author = quotedAuthor,
                        text = quotedText ?: content.string("reply_text") ?: "Mensagem citada",
                        tint = if (c.isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f),
                        onClick = onQuoteClick,
                    )
                }
                val mediaWidth = (ctx.maxWidth - TailWidth - 6.dp).coerceAtMost(280.dp)
                attachments.forEach { media ->
                    AttachmentView(
                        media = media,
                        voice = content.string("type") == "voice",
                        profileId = ctx.profileId,
                        container = ctx.container,
                        width = mediaWidth,
                        accent = if (outgoing && !note) c.bubbleOutAccent else c.brand,
                        onOpenImage = onOpenImage,
                        modifier = Modifier.padding(bottom = 2.dp),
                    )
                }
                if (!deleted) {
                    content.obj("location")?.let { LocationCard(it, mediaWidth) }
                    content.array("contacts")?.forEach { element -> (element as? JsonObject)?.let { ContactCard(it, mediaWidth) } }
                }

                val metaWidth = 36 + (if (edited) 50 else 0) + (if (showTick) 19 else 0)
                val body = when {
                    deleted -> "Mensagem apagada"
                    else -> message.text
                }
                // Áudio sem legenda: o horário sobe para a linha do tempo do player, sem abrir uma linha só para ele.
                val audioOnly = body.isBlank() && attachments.size == 1 && attachments[0].type.startsWith("audio/")
                Box(
                    Modifier
                        .fillMaxWidth()
                        .then(
                            if (audioOnly) Modifier.layout { measurable, constraints ->
                                // Sobe o horário para dentro da área do player (linha da duração), sem ocupar uma linha própria.
                                val placeable = measurable.measure(constraints)
                                val overlap = 15.dp.roundToPx().coerceAtMost(placeable.height)
                                layout(placeable.width, placeable.height - overlap) { placeable.place(0, -overlap) }
                            } else Modifier,
                        )
                        .padding(start = 6.dp, end = 6.dp, top = if (body.isNotBlank()) 3.dp else 0.dp, bottom = 2.dp),
                ) {
                    if (body.isNotBlank()) {
                        val inline = remember(metaWidth) {
                            mapOf("meta" to InlineTextContent(Placeholder(metaWidth.sp, 15.sp, PlaceholderVerticalAlign.TextBottom)) {})
                        }
                        Row(verticalAlignment = Alignment.Top) {
                            if (deleted) {
                                Icon(Icons.Filled.Block, contentDescription = null, tint = subtle, modifier = Modifier.padding(top = 3.dp, end = 5.dp).size(15.dp))
                            }
                            Text(
                                buildAnnotatedString {
                                    append(body)
                                    append(" ")
                                    appendInlineContent("meta", " ")
                                },
                                inlineContent = inline,
                                color = if (deleted) subtle else c.textPrimary,
                                fontSize = 16.sp,
                                lineHeight = 21.sp,
                                fontStyle = if (deleted) FontStyle.Italic else FontStyle.Normal,
                            )
                        }
                    } else {
                        Spacer(Modifier.height(16.dp).width(metaWidth.dp))
                    }
                    Row(Modifier.align(Alignment.BottomEnd), verticalAlignment = Alignment.CenterVertically) {
                        if (note) {
                            Icon(Icons.Filled.Lock, contentDescription = null, tint = subtle, modifier = Modifier.size(11.dp))
                            Spacer(Modifier.width(3.dp))
                        }
                        Text(
                            (if (edited) "Editada " else "") + formatTime(message.created),
                            color = subtle,
                            fontSize = 11.sp,
                            lineHeight = 14.sp,
                            maxLines = 1,
                        )
                        if (showTick) {
                            Spacer(Modifier.width(3.dp))
                            StatusTick(message.delivery_status, subtle, onClick = if (failed) onFailedClick else null)
                        }
                    }
                }
                content.obj("receipts")?.let { receipts ->
                    val total = receipts.size
                    val read = receipts.values.count { (it as? JsonObject)?.string("status") in setOf("read", "played") }
                    Text(
                        "$read leram · $total receberam",
                        color = subtle,
                        fontSize = 11.sp,
                        modifier = Modifier.align(Alignment.End).padding(horizontal = 6.dp).padding(bottom = 2.dp),
                    )
                }
            }
            if (reactions.isNotEmpty()) {
                Row(
                    Modifier
                        .align(Alignment.BottomStart)
                        .offset(y = 18.dp)
                        .padding(start = if (outgoing) 8.dp else TailWidth + 8.dp)
                        .clip(CircleShape)
                        .background(c.background)
                        .padding(1.5.dp)
                        .clip(CircleShape)
                        .background(if (c.isDark) c.surface else c.field)
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    reactions.distinct().take(4).forEach { emoji -> Text(emoji, fontSize = 13.sp) }
                    if (reactions.size > 1) {
                        Spacer(Modifier.width(3.dp))
                        Text(reactions.size.toString(), fontSize = 11.5.sp, color = c.textSecondary)
                    }
                }
            }
        }
    }
}

private class AuthorLabel(val text: String, val color: Color, val icon: ImageVector? = null)

@Composable
private fun authorLabel(message: Message, ctx: BubbleContext, content: JsonObject): AuthorLabel? {
    val c = Wb.colors
    val author = message.author
    val names = ctx.team
    return when {
        message.isNote -> {
            val who = if (author == ctx.meId) "você" else names[author]?.name?.let(::firstName)
            AuthorLabel(if (who != null) "Nota interna · $who" else "Nota interna", c.noteLabel, Icons.Filled.Lock)
        }
        message.isIncoming -> if (ctx.detail.conversation.isGroup) {
            val name = content.string("participant_name")?.takeIf { it.isNotBlank() } ?: content.string("participant") ?: "Participante"
            AuthorLabel(name, avatarColor(name))
        } else null
        author == ctx.meId -> null
        author.startsWith("bot:") -> AuthorLabel(names[author]?.name ?: "Bot", c.bot, Icons.Filled.SmartToy)
        names[author] != null -> AuthorLabel(names[author]!!.name, if (c.isDark) c.accent else c.brand)
        author.isBlank() || author == "system" -> AuthorLabel("Sistema", c.textSecondary)
        author.startsWith("app:") -> AuthorLabel("Integração", c.ticket)
        else -> AuthorLabel("Bot do atendimento", c.bot, Icons.Filled.SmartToy)
    }
}

/** Citação: bloco com barra lateral `brand`; toque rola até a mensagem original. */
@Composable
private fun QuoteBlock(accent: Color, author: String?, text: String, tint: Color, onClick: () -> Unit) {
    val c = Wb.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 2.dp)
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(9.dp))
            .background(tint)
            .clickable(onClick = onClick),
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(accent))
        Column(Modifier.padding(horizontal = 8.dp, vertical = 5.dp)) {
            if (author != null) Text(author, color = accent, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(text, color = if (accent == c.brand) c.textSecondary else c.bubbleOutMeta, fontSize = 13.5.sp, lineHeight = 18.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Ticks: relógio (na fila), ✓ cinza (enviada), ✓✓ cinza (entregue), ✓✓ `tickRead` (lida/ouvida), ! `danger` (falhou). */
@Composable
internal fun StatusTick(status: String, subtle: Color, size: Dp = 16.dp, onClick: (() -> Unit)? = null) {
    val c = Wb.colors
    val (icon, tint) = when (status) {
        "pending", "sending" -> Icons.Filled.Schedule to subtle
        "sent" -> Icons.Filled.Done to subtle
        "delivered" -> Icons.Filled.DoneAll to subtle
        "read", "played" -> Icons.Filled.DoneAll to c.tickRead
        "failed" -> Icons.Filled.ErrorOutline to c.danger
        "unknown" -> Icons.Filled.HelpOutline to subtle
        else -> return
    }
    Icon(
        icon,
        contentDescription = deliveryLabel(status),
        tint = tint,
        modifier = Modifier
            .then(if (onClick != null) Modifier.clip(CircleShape).clickable(onClick = onClick) else Modifier)
            .size(if (status == "pending" || status == "sending") size - 3.dp else size),
    )
}

/** Chip central de data ("Hoje", "Ontem", "12 de novembro"). */
@Composable
internal fun DayChip(label: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Text(
            label,
            color = Wb.colors.textSecondary,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier
                .drawBehind { drawRoundRect(Color.Black.copy(alpha = 0.10f), topLeft = Offset(0f, 1.dp.toPx()), cornerRadius = CornerRadius(8.dp.toPx())) }
                .clip(RoundedCornerShape(8.dp))
                .background(Wb.colors.bubbleSystem)
                .padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

/** Evento do atendimento (assumida, transferida, concluída, menu enviado, protocolo aberto) como chip central com ícone. */
@Composable
internal fun SystemChip(text: String) {
    val c = Wb.colors
    val lower = text.lowercase(Locale.ROOT)
    val (icon, tint) = when {
        "protocolo" in lower -> Icons.Filled.ConfirmationNumber to c.ticket
        "transferid" in lower || "encaminhad" in lower -> Icons.AutoMirrored.Filled.Shortcut to c.brand
        "assumi" in lower -> Icons.Filled.PersonAdd to c.brand
        "conclu" in lower || "encerrad" in lower -> Icons.Filled.TaskAlt to c.muted
        "menu" in lower -> Icons.AutoMirrored.Filled.ListAlt to c.brand
        "bot" in lower || "ia " in lower -> Icons.Filled.SmartToy to c.bot
        else -> Icons.Filled.Info to c.muted
    }
    Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(c.bubbleSystem)
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(text, color = c.textSecondary, fontSize = 12.5.sp, lineHeight = 16.sp, textAlign = TextAlign.Center)
        }
    }
}

/** Entrega pendente (fila de saída que ainda não virou mensagem confirmada). */
@Composable
internal fun DeliveryRow(delivery: Delivery) {
    val c = Wb.colors
    val failed = delivery.status == "failed"
    Box(Modifier.fillMaxWidth().padding(top = 4.dp, end = TailWidth), contentAlignment = Alignment.CenterEnd) {
        Row(
            Modifier.clip(RoundedCornerShape(10.dp)).background(if (failed) c.soft(c.danger, 0.16f) else c.bubbleSystem).padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (failed) Icons.Filled.ErrorOutline else Icons.Filled.Schedule,
                contentDescription = null,
                tint = if (failed) c.danger else c.textSecondary,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                buildString {
                    append(if (failed) "Envio falhou" else "Envio ${deliveryLabel(delivery.status).lowercase(Locale.ROOT)}")
                    delivery.error?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                },
                color = if (failed) c.danger else c.textSecondary,
                fontSize = 12.5.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Localização: cartão com um mapa estilizado; toque abre no app de mapas (geo:) ou no OpenStreetMap. */
@Composable
private fun LocationCard(location: JsonObject, width: Dp) {
    val context = LocalContext.current
    val c = Wb.colors
    val lat = location.double("latitude") ?: return
    val lng = location.double("longitude") ?: return
    val name = location.string("name")?.takeIf { it.isNotBlank() }
    val address = location.string("address")?.takeIf { it.isNotBlank() }
    val coords = String.format(Locale.US, "%.5f, %.5f", lat, lng)
    Column(
        Modifier
            .width(width)
            .padding(bottom = 2.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (c.isDark) Color.White.copy(alpha = 0.06f) else Color.Black.copy(alpha = 0.04f))
            .clickable { openMap(context, lat, lng, name) }
            .semantics { contentDescription = "Localização: ${name ?: coords}. Toque para abrir no mapa." },
    ) {
        val land = c.mapLand
        val road = c.mapRoad
        val water = c.mapWater
        Box(Modifier.fillMaxWidth().height(112.dp).background(land), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxWidth().height(112.dp)) {
                val w = size.width
                val h = size.height
                drawRect(water, topLeft = Offset(w * 0.72f, 0f), size = Size(w * 0.28f, h * 0.42f))
                val stroke = Stroke(width = 9.dp.toPx(), cap = StrokeCap.Round)
                val thin = Stroke(width = 4.dp.toPx(), cap = StrokeCap.Round)
                drawLine(road, Offset(-10f, h * 0.68f), Offset(w + 10f, h * 0.36f), stroke.width, StrokeCap.Round)
                drawLine(road, Offset(w * 0.30f, -10f), Offset(w * 0.46f, h + 10f), stroke.width, StrokeCap.Round)
                drawLine(road, Offset(-10f, h * 0.22f), Offset(w * 0.66f, h * 0.10f), thin.width, StrokeCap.Round)
                drawLine(road, Offset(w * 0.62f, h + 10f), Offset(w * 0.88f, h * 0.45f), thin.width, StrokeCap.Round)
                drawLine(road, Offset(w * 0.08f, h + 10f), Offset(w * 0.20f, h * 0.60f), thin.width, StrokeCap.Round)
            }
            Icon(Icons.Filled.LocationOn, contentDescription = null, tint = c.danger, modifier = Modifier.size(38.dp).offset(y = (-10).dp))
        }
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Text(name ?: "Localização", color = c.textPrimary, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(address ?: coords, color = c.textSecondary, fontSize = 12.5.sp, lineHeight = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun openMap(context: Context, lat: Double, lng: Double, name: String?) {
    val label = Uri.encode(name ?: "Localização")
    val geo = Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng?q=$lat,$lng($label)"))
    try {
        context.startActivity(geo)
    } catch (e: ActivityNotFoundException) {
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/?mlat=$lat&mlon=$lng#map=16/$lat/$lng"))
        runCatching { context.startActivity(web) }
    }
}

/** Abre o app de contatos do aparelho com nome e telefone preenchidos. */
internal fun saveContact(context: Context, name: String, phone: String): Boolean {
    val intent = Intent(ContactsContract.Intents.Insert.ACTION)
        .setType(ContactsContract.RawContacts.CONTENT_TYPE)
        .putExtra(ContactsContract.Intents.Insert.NAME, name)
        .putExtra(ContactsContract.Intents.Insert.PHONE, phone)
    return try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}

/** Cartão de contato: avatar, nome, telefone, "Salvar" e ligar. */
@Composable
private fun ContactCard(contact: JsonObject, width: Dp) {
    val context = LocalContext.current
    val c = Wb.colors
    val name = contact.string("name")?.takeIf { it.isNotBlank() } ?: "Contato"
    val phone = contact.string("phone").orEmpty()
    Column(
        Modifier
            .width(width)
            .padding(bottom = 2.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (c.isDark) Color.White.copy(alpha = 0.06f) else Color.Black.copy(alpha = 0.04f)),
    ) {
        Row(Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(name, seed = phone.ifBlank { name }, size = 40.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(name, color = c.textPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (phone.isNotBlank()) Text(formatPhone(phone), color = c.textSecondary, fontSize = 13.sp, maxLines = 1)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.textSecondary.copy(alpha = 0.18f)))
        Row(Modifier.fillMaxWidth().height(40.dp)) {
            CardAction("Salvar", Icons.Filled.PersonAdd, Modifier.weight(1f)) { saveContact(context, name, phone) }
            if (phone.isNotBlank()) {
                Box(Modifier.width(1.dp).fillMaxHeight().background(c.textSecondary.copy(alpha = 0.18f)))
                CardAction("Ligar", Icons.Filled.Call, Modifier.weight(1f)) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }
                }
            }
        }
    }
}

@Composable
private fun CardAction(label: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    val tint = if (Wb.colors.isDark) Wb.colors.accent else Wb.colors.brand
    Row(modifier.fillMaxHeight().clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, color = tint, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

internal val messageTextStyle = TextStyle(fontSize = 16.sp, lineHeight = 21.sp)
