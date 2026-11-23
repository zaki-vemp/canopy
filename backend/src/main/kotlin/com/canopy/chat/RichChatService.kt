package com.canopy.chat

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.pods.DmSummaryDto
import com.canopy.pods.PodProposalReader
import com.canopy.pods.parsePublicIdOrBadRequest
import com.canopy.security.AuthPrincipal
import com.canopy.util.UuidV7
import com.canopy.ws.PodRealtimeHub
import com.canopy.ws.WsServerFrame
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.ResultSetExtractor
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.jdbc.support.GeneratedKeyHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.server.ResponseStatusException
import java.security.SecureRandom
import java.sql.ResultSet
import java.time.LocalDateTime
import java.time.ZoneOffset

@Service
class RichChatService(
    private val jdbcClient: JdbcClient,
    transactionManager: PlatformTransactionManager,
    private val objectMapper: ObjectMapper,
    private val podRealtimeHub: PodRealtimeHub,
    private val podProposalReader: PodProposalReader
) {
    private val txTemplate = TransactionTemplate(transactionManager)
    private val rng = SecureRandom()

    companion object {
        // Exact MySQL 8.0 InnoDB default stopword list (innodb_ft_server_stopword_table defaults)
        private val INNODB_STOPWORDS = setOf(
            "about", "are", "com", "for", "from", "how", "that", "the",
            "this", "und", "was", "what", "when", "where", "who", "will", "with", "www"
        )

        private val ICEBREAKERS_BY_INTEREST = mapOf(
            "gaming" to listOf(
                "What co-op or multiplayer moment made you laugh the hardest recently?",
                "If our pod queued into one game tonight with zero prep, what are we playing?",
                "What underrated indie game deserves 10x the attention it got?"
            ),
            "music-production" to listOf(
                "What synth patch, drum break, or plugin can you not stop reaching for lately?",
                "Share a 4-bar loop habit that instantly unblocks a blank DAW session."
            ),
            "late-night-coding" to listOf(
                "What tiny side project or CLI tool saved you hours this year?",
                "Tabs aside — what debugging story taught you the most?"
            ),
            "chess" to listOf(
                "What opening do you play purely because the middlegames get chaotic?",
                "Rapid, blitz, or bullet — where do your best ideas show up?"
            )
        )

        private val DEFAULT_ICEBREAKERS = listOf(
            "What small obsession or rabbit hole has had your attention this week?",
            "What got you into this interest in the first place?",
            "Drop one hot take about this topic that you will happily defend!"
        )
    }

    private data class PodMemberContext(
        val podInternalId: Long,
        val podPublicBytes: ByteArray,
        val podIdHex: String,
        val interestSlug: String,
        val myUserId: Long,
        val myPeerId: String,
        val myAlias: String,
        val myColor: String
    )

    private data class DmPeerContext(
        val peerUserId: Long,
        val peerId: String,
        val peerAlias: String,
        val dmLow: Long,
        val dmHigh: Long
    )

    private data class RawMessageRow(
        val id: Long,
        val podInternalId: Long,
        val podPublicBytes: ByteArray,
        val senderUserId: Long,
        val senderUserPublicBytes: ByteArray?,
        val senderAlias: String,
        val senderColor: String,
        val recipientUserId: Long,
        val recipientUserPublicBytes: ByteArray?,
        val recipientAlias: String,
        val dmUserLowId: Long,
        val dmUserHighId: Long,
        val quoteMessageId: Long,
        val msgType: Int,
        val body: String,
        val isPinned: Boolean,
        val isDeleted: Boolean,
        val editedAtIso: String?,
        val createdAtIso: String
    )

    private val rawMessageMapper = RowMapper { rs: ResultSet, _: Int ->
        val editedLdt = rs.getObject("edited_at", LocalDateTime::class.java)
        val createdLdt = rs.getObject("created_at", LocalDateTime::class.java)
        RawMessageRow(
            id = rs.getLong("id"),
            podInternalId = rs.getLong("pod_id"),
            podPublicBytes = rs.getBytes("pod_public_id"),
            senderUserId = rs.getLong("sender_user_id"),
            senderUserPublicBytes = rs.getBytes("sender_public_id"),
            senderAlias = rs.getString("sender_alias"),
            senderColor = rs.getString("sender_color"),
            recipientUserId = rs.getLong("recipient_user_id"),
            recipientUserPublicBytes = rs.getBytes("recipient_public_id"),
            recipientAlias = rs.getString("recipient_alias") ?: "",
            dmUserLowId = rs.getLong("dm_user_low_id"),
            dmUserHighId = rs.getLong("dm_user_high_id"),
            quoteMessageId = rs.getLong("quote_message_id"),
            msgType = rs.getInt("msg_type"),
            body = rs.getString("body") ?: "",
            isPinned = rs.getInt("is_pinned") != 0,
            isDeleted = rs.getInt("is_deleted") != 0,
            editedAtIso = editedLdt?.toInstant(ZoneOffset.UTC)?.toString(),
            createdAtIso = (createdLdt ?: LocalDateTime.now(ZoneOffset.UTC)).toInstant(ZoneOffset.UTC).toString()
        )
    }

    private fun selectFromMessages(indexHint: String = ""): String = """
        SELECT m.id,
               m.pod_id,
               p.public_id AS pod_public_id,
               m.sender_user_id,
               su.public_id AS sender_public_id,
               m.sender_alias,
               m.sender_color,
               m.recipient_user_id,
               ru.public_id AS recipient_public_id,
               m.recipient_alias,
               m.dm_user_low_id,
               m.dm_user_high_id,
               m.quote_message_id,
               m.msg_type,
               m.body,
               m.is_pinned,
               m.is_deleted,
               m.edited_at,
               m.created_at
        FROM messages m $indexHint
        JOIN pods p ON p.id = m.pod_id
        LEFT JOIN users su ON su.id = m.sender_user_id
        LEFT JOIN users ru ON ru.id = m.recipient_user_id
    """.trimIndent()

    private val baseMessageSelect = selectFromMessages()
    private val convoCursorSelect = selectFromMessages("FORCE INDEX (idx_messages_convo_cursor)")
    private val podPinnedSelect = selectFromMessages("FORCE INDEX (idx_messages_pod_pinned)")

    fun listPodMessages(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        beforeId: Long,
        limit: Int
    ): MessagesPageResponse {
        val ctx = requirePodMemberContext(principal, podIdHexRaw)
        return fetchConversationPage(
            podInternalId = ctx.podInternalId,
            dmLow = 0L,
            dmHigh = 0L,
            beforeId = beforeId,
            limit = limit,
            callerUserId = principal.userId()
        )
    }

    fun listDmConversations(principal: AuthPrincipal, podIdHexRaw: String): List<DmSummaryDto> {
        val ctx = requirePodMemberContext(principal, podIdHexRaw)
        return podRealtimeHub.loadDmSummariesByPod(principal.userId(), listOf(ctx.podInternalId))[ctx.podInternalId]
            ?: emptyList()
    }

    fun listDmMessages(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        peerIdRaw: String,
        beforeId: Long,
        limit: Int
    ): MessagesPageResponse {
        val ctx = requirePodMemberContext(principal, podIdHexRaw)
        val peer = resolveDmPeer(ctx, peerIdRaw)
        return fetchConversationPage(
            podInternalId = ctx.podInternalId,
            dmLow = peer.dmLow,
            dmHigh = peer.dmHigh,
            beforeId = beforeId,
            limit = limit,
            callerUserId = principal.userId()
        )
    }

    private fun fetchConversationPage(
        podInternalId: Long,
        dmLow: Long,
        dmHigh: Long,
        beforeId: Long,
        limit: Int,
        callerUserId: Long
    ): MessagesPageResponse {
        val safeLimit = limit.coerceIn(1, 100)
        val fetchLimit = safeLimit + 1

        val rowsDesc = if (beforeId > 0L) {
            jdbcClient.sql(
                """
                $convoCursorSelect
                WHERE m.pod_id = :podId
                  AND m.dm_user_low_id = :dmLow
                  AND m.dm_user_high_id = :dmHigh
                  AND m.id < :beforeId
                ORDER BY m.id DESC
                LIMIT :fetchLimit
                """.trimIndent()
            )
                .param("podId", podInternalId)
                .param("dmLow", dmLow)
                .param("dmHigh", dmHigh)
                .param("beforeId", beforeId)
                .param("fetchLimit", fetchLimit)
                .query(rawMessageMapper)
                .list()
        } else {
            jdbcClient.sql(
                """
                $convoCursorSelect
                WHERE m.pod_id = :podId
                  AND m.dm_user_low_id = :dmLow
                  AND m.dm_user_high_id = :dmHigh
                ORDER BY m.id DESC
                LIMIT :fetchLimit
                """.trimIndent()
            )
                .param("podId", podInternalId)
                .param("dmLow", dmLow)
                .param("dmHigh", dmHigh)
                .param("fetchLimit", fetchLimit)
                .query(rawMessageMapper)
                .list()
        }

        val hasMore = rowsDesc.size > safeLimit
        val pageDesc = if (hasMore) rowsDesc.take(safeLimit) else rowsDesc
        val chronological = pageDesc.asReversed()
        val nextBeforeId = if (hasMore && chronological.isNotEmpty()) chronological.first().id else 0L

        val hydrated = hydrateMessages(chronological, callerUserId)
        return MessagesPageResponse(messages = hydrated, nextBeforeId = nextBeforeId)
    }

    fun sendPodMessage(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: SendMessageRequest
    ): SendMessageResponse {
        val ctx = requirePodMemberContext(principal, podIdHexRaw)
        val trimmed = req.body.trim()

        if (trimmed.equals("/status", ignoreCase = true) || trimmed.startsWith("/status ", ignoreCase = true)) {
            val newStatus = trimmed.drop("/status".length).trim().take(80)
            jdbcClient.sql("UPDATE pod_members SET custom_status = :status WHERE pod_id = :podId AND user_id = :userId")
                .param("status", newStatus)
                .param("podId", ctx.podInternalId)
                .param("userId", principal.userId())
                .update()
            podRealtimeHub.clearGroupTyping(ctx.podIdHex, ctx.myAlias)
            podRealtimeHub.broadcastPresenceSnapshot(ctx.podInternalId, ctx.podIdHex)
            return SendMessageResponse(message = null, commandHandled = "status")
        }

        var msgType = 1 // TEXT
        var effectiveBody = trimmed
        var parsedPoll: Pair<String, List<String>>? = null

        when {
            trimmed.equals("/poll", ignoreCase = true) || trimmed.startsWith("/poll ", ignoreCase = true) -> {
                val pollSpec = parsePollCommand(trimmed)
                msgType = 3 // POLL
                effectiveBody = pollSpec.first
                parsedPoll = pollSpec
            }
            trimmed.equals("/icebreaker", ignoreCase = true) || trimmed.startsWith("/icebreaker ", ignoreCase = true) -> {
                val customPrompt = trimmed.drop("/icebreaker".length).trim()
                val pool = ICEBREAKERS_BY_INTEREST[ctx.interestSlug] ?: DEFAULT_ICEBREAKERS
                msgType = 5 // ICEBREAKER
                effectiveBody = if (customPrompt.isNotEmpty()) customPrompt else pool[rng.nextInt(pool.size)]
            }
            trimmed.equals("/shrug", ignoreCase = true) || trimmed.startsWith("/shrug ", ignoreCase = true) -> {
                val prefix = trimmed.drop("/shrug".length).trim()
                effectiveBody = if (prefix.isEmpty()) "¯\\_(ツ)_/¯" else "$prefix ¯\\_(ツ)_/¯"
            }
        }

        if (effectiveBody.length > 4000) {
            effectiveBody = effectiveBody.take(4000)
        }

        val requestedAttachmentIds = req.attachmentIds.filter { it > 0L }.distinct().take(10)
        if (effectiveBody.isBlank() && requestedAttachmentIds.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Message body or attachment is required")
        }

        val newMessageId = insertMessageTx(
            ctx = ctx,
            recipientUserId = 0L,
            recipientAlias = "",
            dmLow = 0L,
            dmHigh = 0L,
            quoteMessageId = req.quoteMessageId,
            initialMsgType = msgType,
            effectiveBody = effectiveBody,
            requestedAttachmentIds = requestedAttachmentIds,
            parsedPoll = parsedPoll
        )

        podRealtimeHub.clearGroupTyping(ctx.podIdHex, ctx.myAlias)
        val newDto = fetchSingleHydratedMessage(newMessageId, principal.userId())
        podRealtimeHub.broadcastToPod(ctx.podIdHex, WsServerFrame.MessageCreatedOut(message = newDto))
        return SendMessageResponse(message = newDto)
    }

    fun sendDmMessage(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        peerIdRaw: String,
        req: SendMessageRequest
    ): SendMessageResponse {
        val ctx = requirePodMemberContext(principal, podIdHexRaw)
        val peer = resolveDmPeer(ctx, peerIdRaw)
        val trimmed = req.body.trim()

        if (trimmed.equals("/status", ignoreCase = true) || trimmed.startsWith("/status ", ignoreCase = true)) {
            val newStatus = trimmed.drop("/status".length).trim().take(80)
            jdbcClient.sql("UPDATE pod_members SET custom_status = :status WHERE pod_id = :podId AND user_id = :userId")
                .param("status", newStatus)
                .param("podId", ctx.podInternalId)
                .param("userId", principal.userId())
                .update()
            podRealtimeHub.clearDmTyping(ctx.podIdHex, principal.userId(), ctx.myPeerId, peer.peerUserId, peer.peerId)
            podRealtimeHub.broadcastPresenceSnapshot(ctx.podInternalId, ctx.podIdHex)
            return SendMessageResponse(message = null, commandHandled = "status")
        }

        var effectiveBody = trimmed
        if (trimmed.equals("/shrug", ignoreCase = true) || trimmed.startsWith("/shrug ", ignoreCase = true)) {
            val prefix = trimmed.drop("/shrug".length).trim()
            effectiveBody = if (prefix.isEmpty()) "¯\\_(ツ)_/¯" else "$prefix ¯\\_(ツ)_/¯"
        }
        if (effectiveBody.length > 4000) {
            effectiveBody = effectiveBody.take(4000)
        }

        val requestedAttachmentIds = req.attachmentIds.filter { it > 0L }.distinct().take(10)
        if (effectiveBody.isBlank() && requestedAttachmentIds.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Message body or attachment is required")
        }

        val newMessageId = insertMessageTx(
            ctx = ctx,
            recipientUserId = peer.peerUserId,
            recipientAlias = peer.peerAlias,
            dmLow = peer.dmLow,
            dmHigh = peer.dmHigh,
            quoteMessageId = req.quoteMessageId,
            initialMsgType = 1,
            effectiveBody = effectiveBody,
            requestedAttachmentIds = requestedAttachmentIds,
            parsedPoll = null
        )

        podRealtimeHub.clearDmTyping(ctx.podIdHex, principal.userId(), ctx.myPeerId, peer.peerUserId, peer.peerId)
        val newDto = fetchSingleHydratedMessage(newMessageId, principal.userId())
        podRealtimeHub.sendToUsers(
            ctx.podIdHex,
            setOf(principal.userId(), peer.peerUserId),
            WsServerFrame.MessageCreatedOut(message = newDto)
        )
        return SendMessageResponse(message = newDto)
    }

    private fun insertMessageTx(
        ctx: PodMemberContext,
        recipientUserId: Long,
        recipientAlias: String,
        dmLow: Long,
        dmHigh: Long,
        quoteMessageId: Long,
        initialMsgType: Int,
        effectiveBody: String,
        requestedAttachmentIds: List<Long>,
        parsedPoll: Pair<String, List<String>>?
    ): Long {
        return txTemplate.execute {
            var validQuoteId = 0L
            if (quoteMessageId > 0L) {
                validQuoteId = jdbcClient.sql(
                    """
                    SELECT id
                    FROM messages
                    WHERE id = :qid
                      AND pod_id = :podId
                      AND dm_user_low_id = :dmLow
                      AND dm_user_high_id = :dmHigh
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("qid", quoteMessageId)
                    .param("podId", ctx.podInternalId)
                    .param("dmLow", dmLow)
                    .param("dmHigh", dmHigh)
                    .query { rs, _ -> rs.getLong("id") }
                    .optional()
                    .orElse(0L)
            }

            var msgType = initialMsgType
            var validAttachmentIds = emptyList<Long>()
            if (requestedAttachmentIds.isNotEmpty()) {
                val foundAttachments = jdbcClient.sql(
                    """
                    SELECT id, kind
                    FROM message_attachments
                    WHERE id IN (:attIds)
                      AND pod_id = :podId
                      AND uploader_user_id = :userId
                      AND message_id = 0
                    """.trimIndent()
                )
                    .param("attIds", requestedAttachmentIds)
                    .param("podId", ctx.podInternalId)
                    .param("userId", ctx.myUserId)
                    .query { rs, _ -> rs.getLong("id") to rs.getString("kind") }
                    .list()

                validAttachmentIds = foundAttachments.map { it.first }
                if (msgType == 1 && foundAttachments.any { it.second.equals("voice_note", ignoreCase = true) }) {
                    msgType = 4 // VOICE_NOTE
                }
            }

            val kh = GeneratedKeyHolder()
            jdbcClient.sql(
                """
                INSERT INTO messages (
                    pod_id, sender_user_id, sender_alias, sender_color,
                    recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id,
                    quote_message_id, msg_type, body, created_at
                ) VALUES (
                    :podId, :userId, :alias, :color,
                    :recipientUserId, :recipientAlias, :dmLow, :dmHigh,
                    :quoteId, :msgType, :body, UTC_TIMESTAMP()
                )
                """.trimIndent()
            )
                .param("podId", ctx.podInternalId)
                .param("userId", ctx.myUserId)
                .param("alias", ctx.myAlias)
                .param("color", ctx.myColor)
                .param("recipientUserId", recipientUserId)
                .param("recipientAlias", recipientAlias)
                .param("dmLow", dmLow)
                .param("dmHigh", dmHigh)
                .param("quoteId", validQuoteId)
                .param("msgType", msgType)
                .param("body", effectiveBody)
                .update(kh)

            val insertedMsgId = kh.key?.toLong()
                ?: throw IllegalStateException("Failed to insert message")

            if (validAttachmentIds.isNotEmpty()) {
                jdbcClient.sql(
                    """
                    UPDATE message_attachments
                    SET message_id = :messageId
                    WHERE id IN (:attIds)
                      AND pod_id = :podId
                      AND uploader_user_id = :userId
                      AND message_id = 0
                    """.trimIndent()
                )
                    .param("messageId", insertedMsgId)
                    .param("attIds", validAttachmentIds)
                    .param("podId", ctx.podInternalId)
                    .param("userId", ctx.myUserId)
                    .update()
            }

            if (parsedPoll != null) {
                val (question, options) = parsedPoll
                jdbcClient.sql(
                    """
                    INSERT INTO polls (message_id, question, options_json, is_closed, created_at)
                    VALUES (:messageId, :question, :optionsJson, 0, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("messageId", insertedMsgId)
                    .param("question", question.take(240))
                    .param("optionsJson", objectMapper.writeValueAsString(options))
                    .update()
            }

            insertedMsgId
        }!!
    }

    fun editMessage(principal: AuthPrincipal, messageId: Long, req: EditMessageRequest): RichMessageDto {
        val cleanBody = req.body.trim().take(4000)
        if (cleanBody.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Edited message body cannot be blank")
        }

        val meta = requireMessageAndMembership(principal.userId(), messageId)
        if (meta.senderUserId != principal.userId()) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Only the message author can edit this message")
        }
        if (meta.isDeleted) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot edit a deleted message")
        }

        jdbcClient.sql("UPDATE messages SET body = :body, edited_at = UTC_TIMESTAMP() WHERE id = :id")
            .param("body", cleanBody)
            .param("id", messageId)
            .update()

        val updated = fetchSingleHydratedMessage(messageId, principal.userId())
        dispatchMessageFrame(meta, WsServerFrame.MessageUpdatedOut(message = updated))
        return updated
    }

    fun deleteMessage(principal: AuthPrincipal, messageId: Long) {
        val meta = requireMessageAndMembership(principal.userId(), messageId)
        if (meta.senderUserId != principal.userId()) {
            throw ResponseStatusException(HttpStatus.FORBIDDEN, "Only the message author can delete this message")
        }

        jdbcClient.sql("UPDATE messages SET is_deleted = 1, body = '', edited_at = UTC_TIMESTAMP() WHERE id = :id")
            .param("id", messageId)
            .update()

        dispatchMessageFrame(
            meta,
            WsServerFrame.MessageDeletedOut(
                messageId = messageId,
                senderPeerId = meta.senderPeerId,
                recipientPeerId = meta.recipientPeerId
            )
        )
    }

    fun toggleReaction(principal: AuthPrincipal, messageId: Long, emojiRaw: String): RichMessageDto {
        val emoji = emojiRaw.trim().take(32)
        if (emoji.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "emoji is required")
        }

        val meta = requireMessageAndMembership(principal.userId(), messageId)
        if (meta.isDeleted) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot react to a deleted message")
        }

        txTemplate.executeWithoutResult {
            val deleted = jdbcClient.sql(
                "DELETE FROM message_reactions WHERE message_id = :msgId AND emoji = :emoji AND user_id = :userId"
            )
                .param("msgId", messageId)
                .param("emoji", emoji)
                .param("userId", principal.userId())
                .update()

            if (deleted == 0) {
                jdbcClient.sql(
                    """
                    INSERT IGNORE INTO message_reactions (message_id, emoji, user_id, reactor_alias, created_at)
                    VALUES (:msgId, :emoji, :userId, :alias, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("msgId", messageId)
                    .param("emoji", emoji)
                    .param("userId", principal.userId())
                    .param("alias", meta.myAlias)
                    .update()
            }
        }

        val updated = fetchSingleHydratedMessage(messageId, principal.userId())
        dispatchMessageFrame(meta, WsServerFrame.ReactionUpdatedOut(message = updated))
        return updated
    }

    fun togglePin(principal: AuthPrincipal, messageId: Long): RichMessageDto {
        val meta = requireMessageAndMembership(principal.userId(), messageId)
        if (meta.isDeleted) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot pin a deleted message")
        }

        jdbcClient.sql(
            "UPDATE messages SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END WHERE id = :id"
        )
            .param("id", messageId)
            .update()

        val updated = fetchSingleHydratedMessage(messageId, principal.userId())
        dispatchMessageFrame(meta, WsServerFrame.PinUpdatedOut(message = updated))
        return updated
    }

    fun toggleBookmark(principal: AuthPrincipal, messageId: Long): ToggleBookmarkResponse {
        val meta = requireMessageAndMembership(principal.userId(), messageId)

        val nowBookmarked = txTemplate.execute {
            val deleted = jdbcClient.sql(
                "DELETE FROM user_bookmarks WHERE user_id = :userId AND message_id = :msgId"
            )
                .param("userId", principal.userId())
                .param("msgId", messageId)
                .update()

            if (deleted > 0) {
                false
            } else {
                jdbcClient.sql(
                    """
                    INSERT IGNORE INTO user_bookmarks (user_id, message_id, pod_id, created_at)
                    VALUES (:userId, :msgId, :podId, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("userId", principal.userId())
                    .param("msgId", messageId)
                    .param("podId", meta.podInternalId)
                    .update()
                true
            }
        }!!

        val updated = fetchSingleHydratedMessage(messageId, principal.userId())
        return ToggleBookmarkResponse(bookmarked = nowBookmarked, message = updated)
    }

    fun votePoll(principal: AuthPrincipal, pollId: Long, optionIndex: Int): RichMessageDto {
        data class PollLookup(
            val pollId: Long,
            val messageId: Long,
            val optionsJson: String,
            val isClosed: Boolean,
            val podInternalId: Long,
            val podIdHex: String,
            val dmLow: Long,
            val dmHigh: Long,
            val myAlias: String
        )

        val lookup = jdbcClient.sql(
            """
            SELECT pl.id AS poll_id,
                   pl.message_id,
                   pl.options_json,
                   pl.is_closed,
                   m.pod_id,
                   m.dm_user_low_id,
                   m.dm_user_high_id,
                   p.public_id AS pod_public_id,
                   pm.alias AS my_alias
            FROM polls pl
            JOIN messages m ON m.id = pl.message_id
            JOIN pods p ON p.id = m.pod_id
            LEFT JOIN pod_members pm ON pm.pod_id = m.pod_id AND pm.user_id = :userId
            WHERE pl.id = :pollId
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .param("pollId", pollId)
            .query { rs, _ ->
                val alias = rs.getString("my_alias")
                    ?: throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")
                val dmLow = rs.getLong("dm_user_low_id")
                val dmHigh = rs.getLong("dm_user_high_id")
                if (dmLow > 0L && principal.userId() != dmLow && principal.userId() != dmHigh) {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Private message restricted to participants")
                }
                PollLookup(
                    pollId = rs.getLong("poll_id"),
                    messageId = rs.getLong("message_id"),
                    optionsJson = rs.getString("options_json"),
                    isClosed = rs.getInt("is_closed") != 0,
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(rs.getBytes("pod_public_id")),
                    dmLow = dmLow,
                    dmHigh = dmHigh,
                    myAlias = alias
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Poll not found") }

        if (lookup.isClosed) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Poll is closed")
        }

        val options: List<String> = objectMapper.readValue(
            lookup.optionsJson,
            object : TypeReference<List<String>>() {}
        )
        if (optionIndex !in options.indices) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid poll optionIndex")
        }

        jdbcClient.sql(
            """
            INSERT INTO poll_votes (poll_id, user_id, option_index, voter_alias, created_at)
            VALUES (:pollId, :userId, :optionIndex, :alias, UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE
                option_index = VALUES(option_index),
                voter_alias = VALUES(voter_alias),
                created_at = UTC_TIMESTAMP()
            """.trimIndent()
        )
            .param("pollId", pollId)
            .param("userId", principal.userId())
            .param("optionIndex", optionIndex)
            .param("alias", lookup.myAlias)
            .update()

        val updated = fetchSingleHydratedMessage(lookup.messageId, principal.userId())
        val frame = WsServerFrame.PollUpdatedOut(message = updated)
        if (lookup.dmLow > 0L) {
            podRealtimeHub.sendToUsers(lookup.podIdHex, setOf(lookup.dmLow, lookup.dmHigh), frame)
        } else {
            podRealtimeHub.broadcastToPod(lookup.podIdHex, frame)
        }
        return updated
    }

    fun listPodPins(principal: AuthPrincipal, podIdHexRaw: String): List<RichMessageDto> {
        val podInternalId = requirePodMembershipInternalId(principal.userId(), podIdHexRaw)
        val rows = jdbcClient.sql(
            """
            $podPinnedSelect
            WHERE m.pod_id = :podId
              AND m.dm_user_low_id = 0
              AND m.is_pinned = 1
              AND m.is_deleted = 0
            ORDER BY m.id DESC
            LIMIT 100
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query(rawMessageMapper)
            .list()
        return hydrateMessages(rows, principal.userId())
    }

    fun listBookmarks(principal: AuthPrincipal): List<RichMessageDto> {
        val rows = jdbcClient.sql(
            """
            $baseMessageSelect
            JOIN user_bookmarks ub ON ub.message_id = m.id AND ub.user_id = :userId
            JOIN pod_members pm ON pm.pod_id = m.pod_id AND pm.user_id = :userId
            WHERE m.is_deleted = 0
              AND (m.dm_user_low_id = 0 OR m.dm_user_low_id = :userId OR m.dm_user_high_id = :userId)
            ORDER BY ub.created_at DESC, m.id DESC
            LIMIT 100
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .query(rawMessageMapper)
            .list()
        return hydrateMessages(rows, principal.userId())
    }

    fun searchPodMessages(principal: AuthPrincipal, podIdHexRaw: String, rawQuery: String): List<RichMessageDto> {
        val podInternalId = requirePodMembershipInternalId(principal.userId(), podIdHexRaw)
        val trimmed = rawQuery.trim()
        if (trimmed.isEmpty()) return emptyList()

        val wordTokens = Regex("[\\p{L}\\p{N}_]+")
            .findAll(trimmed)
            .map { it.value }
            .toList()

        val ftTokens = wordTokens
            .filter { it.length >= 3 && it.lowercase() !in INNODB_STOPWORDS }
            .take(8)

        val rows = if (ftTokens.isNotEmpty() && wordTokens.all { it.length >= 3 || it.lowercase() in INNODB_STOPWORDS }) {
            val booleanQuery = ftTokens.joinToString(" ") { "+$it*" }
            jdbcClient.sql(
                """
                $baseMessageSelect
                WHERE m.pod_id = :podId
                  AND m.is_deleted = 0
                  AND (m.dm_user_low_id = 0 OR m.dm_user_low_id = :myUserId OR m.dm_user_high_id = :myUserId)
                  AND MATCH(m.body) AGAINST(:booleanQuery IN BOOLEAN MODE)
                ORDER BY m.id DESC
                LIMIT 50
                """.trimIndent()
            )
                .param("podId", podInternalId)
                .param("myUserId", principal.userId())
                .param("booleanQuery", booleanQuery)
                .query(rawMessageMapper)
                .list()
        } else {
            // ponytail: <3 char token fallback uses pod-scoped LIKE; move to Meilisearch if pods exceed 100k messages
            val escaped = trimmed
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            jdbcClient.sql(
                """
                $baseMessageSelect
                WHERE m.pod_id = :podId
                  AND m.is_deleted = 0
                  AND (m.dm_user_low_id = 0 OR m.dm_user_low_id = :myUserId OR m.dm_user_high_id = :myUserId)
                  AND m.body LIKE :likePattern
                ORDER BY m.id DESC
                LIMIT 50
                """.trimIndent()
            )
                .param("podId", podInternalId)
                .param("myUserId", principal.userId())
                .param("likePattern", "%$escaped%")
                .query(rawMessageMapper)
                .list()
        }

        return hydrateMessages(rows, principal.userId())
    }

    internal fun fetchSingleHydratedMessage(messageId: Long, callerUserId: Long): RichMessageDto {
        return fetchAndHydrateByIds(listOf(messageId), callerUserId)[messageId]
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Message not found")
    }

    private fun fetchAndHydrateByIds(ids: List<Long>, callerUserId: Long): Map<Long, RichMessageDto> {
        if (ids.isEmpty()) return emptyMap()
        val rows = jdbcClient.sql(
            """
            $baseMessageSelect
            WHERE m.id IN (:ids)
            """.trimIndent()
        )
            .param("ids", ids)
            .query(rawMessageMapper)
            .list()
        return hydrateMessages(rows, callerUserId).associateBy { it.id }
    }

    /**
     * Batch-hydrates reactions, attachments, caller bookmarks, quoted message snippets,
     * polls + poll votes, and governance proposals in flat IN(...) queries (zero N+1 queries).
     */
    private fun hydrateMessages(rows: List<RawMessageRow>, callerUserId: Long): List<RichMessageDto> {
        if (rows.isEmpty()) return emptyList()

        val messageIds = rows.map { it.id }

        // 1. Batch fetch reactions
        data class RawReaction(val emoji: String, val userId: Long, val alias: String)
        val reactionsByMsg = HashMap<Long, MutableList<RawReaction>>()
        jdbcClient.sql(
            """
            SELECT message_id, emoji, user_id, reactor_alias
            FROM message_reactions
            WHERE message_id IN (:msgIds)
            ORDER BY created_at ASC
            """.trimIndent()
        )
            .param("msgIds", messageIds)
            .query { rs ->
                val mid = rs.getLong("message_id")
                reactionsByMsg.computeIfAbsent(mid) { mutableListOf() }.add(
                    RawReaction(
                        emoji = rs.getString("emoji"),
                        userId = rs.getLong("user_id"),
                        alias = rs.getString("reactor_alias")
                    )
                )
            }

        // 2. Batch fetch attachments
        val attachmentsByMsg = HashMap<Long, MutableList<AttachmentDto>>()
        jdbcClient.sql(
            """
            SELECT id, message_id, kind, file_name, mime_type, size_bytes, duration_ms
            FROM message_attachments
            WHERE message_id IN (:msgIds)
            ORDER BY id ASC
            """.trimIndent()
        )
            .param("msgIds", messageIds)
            .query { rs ->
                val attId = rs.getLong("id")
                val mid = rs.getLong("message_id")
                attachmentsByMsg.computeIfAbsent(mid) { mutableListOf() }.add(
                    AttachmentDto(
                        id = attId,
                        kind = rs.getString("kind"),
                        fileName = rs.getString("file_name"),
                        mimeType = rs.getString("mime_type"),
                        sizeBytes = rs.getLong("size_bytes"),
                        durationMs = rs.getLong("duration_ms"),
                        url = "/api/attachments/$attId"
                    )
                )
            }

        // 3. Batch fetch caller bookmarks
        val bookmarkedMsgIds: Set<Long> = if (callerUserId > 0L) {
            jdbcClient.sql(
                """
                SELECT message_id
                FROM user_bookmarks
                WHERE user_id = :userId AND message_id IN (:msgIds)
                """.trimIndent()
            )
                .param("userId", callerUserId)
                .param("msgIds", messageIds)
                .query { rs, _ -> rs.getLong("message_id") }
                .set()
        } else {
            emptySet()
        }

        // 4. Batch fetch quoted snippets (enforcing exact conversation scope match)
        data class ScopedQuote(
            val podInternalId: Long,
            val dmLow: Long,
            val dmHigh: Long,
            val dto: QuoteSnippetDto
        )
        val quoteIds = rows.map { it.quoteMessageId }.filter { it > 0L }.distinct()
        val quotesById = HashMap<Long, ScopedQuote>()
        if (quoteIds.isNotEmpty()) {
            jdbcClient.sql(
                """
                SELECT m.id,
                       m.pod_id,
                       p.public_id AS pod_public_id,
                       m.sender_user_id,
                       u.public_id AS sender_public_id,
                       m.sender_alias,
                       m.sender_color,
                       m.dm_user_low_id,
                       m.dm_user_high_id,
                       m.body,
                       m.msg_type,
                       m.is_deleted
                FROM messages m
                JOIN pods p ON p.id = m.pod_id
                LEFT JOIN users u ON u.id = m.sender_user_id
                WHERE m.id IN (:quoteIds)
                """.trimIndent()
            )
                .param("quoteIds", quoteIds)
                .query { rs ->
                    val qid = rs.getLong("id")
                    val podPub = rs.getBytes("pod_public_id")
                    val senderUserPub = rs.getBytes("sender_public_id")
                    val senderPeerId = if (rs.getLong("sender_user_id") > 0L && senderUserPub != null) {
                        UuidV7.peerId(podPub, senderUserPub)
                    } else {
                        "system"
                    }
                    val deleted = rs.getInt("is_deleted") != 0
                    quotesById[qid] = ScopedQuote(
                        podInternalId = rs.getLong("pod_id"),
                        dmLow = rs.getLong("dm_user_low_id"),
                        dmHigh = rs.getLong("dm_user_high_id"),
                        dto = QuoteSnippetDto(
                            id = qid,
                            senderPeerId = senderPeerId,
                            senderAlias = rs.getString("sender_alias"),
                            senderColor = rs.getString("sender_color"),
                            body = if (deleted) "" else (rs.getString("body") ?: "").take(240),
                            msgType = msgTypeToName(rs.getInt("msg_type")),
                            isDeleted = deleted
                        )
                    )
                }
        }

        // 5. Batch fetch polls & poll votes
        val pollMsgIds = rows.filter { it.msgType == 3 }.map { it.id }
        val pollsByMsgId = HashMap<Long, PollDto>()
        if (pollMsgIds.isNotEmpty()) {
            data class RawPoll(
                val pollId: Long,
                val messageId: Long,
                val question: String,
                val options: List<String>,
                val isClosed: Boolean
            )

            val rawPolls = jdbcClient.sql(
                """
                SELECT id, message_id, question, options_json, is_closed
                FROM polls
                WHERE message_id IN (:msgIds)
                """.trimIndent()
            )
                .param("msgIds", pollMsgIds)
                .query { rs, _ ->
                    val opts: List<String> = objectMapper.readValue(
                        rs.getString("options_json"),
                        object : TypeReference<List<String>>() {}
                    )
                    RawPoll(
                        pollId = rs.getLong("id"),
                        messageId = rs.getLong("message_id"),
                        question = rs.getString("question"),
                        options = opts,
                        isClosed = rs.getInt("is_closed") != 0
                    )
                }
                .list()

            if (rawPolls.isNotEmpty()) {
                val pollIds = rawPolls.map { it.pollId }
                data class RawVote(val userId: Long, val optionIndex: Int, val alias: String)
                val votesByPollId = HashMap<Long, MutableList<RawVote>>()

                jdbcClient.sql(
                    """
                    SELECT poll_id, user_id, option_index, voter_alias
                    FROM poll_votes
                    WHERE poll_id IN (:pollIds)
                    ORDER BY created_at ASC
                    """.trimIndent()
                )
                    .param("pollIds", pollIds)
                    .query { rs ->
                        val pid = rs.getLong("poll_id")
                        votesByPollId.computeIfAbsent(pid) { mutableListOf() }.add(
                            RawVote(
                                userId = rs.getLong("user_id"),
                                optionIndex = rs.getInt("option_index"),
                                alias = rs.getString("voter_alias")
                            )
                        )
                    }

                for (rp in rawPolls) {
                    val votes = votesByPollId[rp.pollId] ?: emptyList()
                    val optDtos = rp.options.mapIndexed { idx, label ->
                        val matching = votes.filter { it.optionIndex == idx }
                        PollOptionDto(
                            index = idx,
                            label = label,
                            votes = matching.size,
                            voters = matching.map { it.alias },
                            meVoted = matching.any { it.userId == callerUserId }
                        )
                    }
                    pollsByMsgId[rp.messageId] = PollDto(
                        pollId = rp.pollId,
                        question = rp.question,
                        isClosed = rp.isClosed,
                        options = optDtos
                    )
                }
            }
        }

        // 6. Batch fetch governance proposals
        val govRows = rows.filter { it.msgType == 6 }
        val proposalsByMsgId = if (govRows.isNotEmpty()) {
            podProposalReader.loadByAnnouncementMessageIds(
                podIds = govRows.map { it.podInternalId }.distinct(),
                messageIds = govRows.map { it.id },
                callerUserId = callerUserId
            )
        } else {
            emptyMap()
        }

        return rows.map { r ->
            val podHex = UuidV7.toHex(r.podPublicBytes)
            val senderPeerId = if (r.senderUserId > 0L && r.senderUserPublicBytes != null) {
                UuidV7.peerId(r.podPublicBytes, r.senderUserPublicBytes)
            } else {
                "system"
            }
            val recipientPeerId = if (r.recipientUserId > 0L && r.recipientUserPublicBytes != null) {
                UuidV7.peerId(r.podPublicBytes, r.recipientUserPublicBytes)
            } else {
                null
            }
            val recipientAlias = if (r.recipientUserId > 0L && r.recipientAlias.isNotBlank()) {
                r.recipientAlias
            } else {
                null
            }

            val groupedReactions = LinkedHashMap<String, MutableList<Pair<Long, String>>>()
            reactionsByMsg[r.id]?.forEach { rx ->
                groupedReactions.computeIfAbsent(rx.emoji) { mutableListOf() }.add(rx.userId to rx.alias)
            }
            val reactionDtos = groupedReactions.map { (emoji, entries) ->
                ReactionGroupDto(
                    emoji = emoji,
                    count = entries.size,
                    aliases = entries.map { it.second },
                    meReacted = entries.any { it.first == callerUserId }
                )
            }

            val quoteSnippet = if (r.quoteMessageId > 0L) {
                quotesById[r.quoteMessageId]?.takeIf {
                    it.podInternalId == r.podInternalId &&
                        it.dmLow == r.dmUserLowId &&
                        it.dmHigh == r.dmUserHighId
                }?.dto
            } else {
                null
            }

            RichMessageDto(
                id = r.id,
                podId = podHex,
                senderPeerId = senderPeerId,
                senderAlias = r.senderAlias,
                senderColor = r.senderColor,
                recipientPeerId = recipientPeerId,
                recipientAlias = recipientAlias,
                quoteMessage = quoteSnippet,
                msgType = msgTypeToName(r.msgType),
                body = if (r.isDeleted) "" else r.body,
                isPinned = r.isPinned,
                isBookmarked = r.id in bookmarkedMsgIds,
                isDeleted = r.isDeleted,
                editedAt = r.editedAtIso,
                createdAt = r.createdAtIso,
                reactions = reactionDtos,
                attachments = if (r.isDeleted) emptyList() else (attachmentsByMsg[r.id] ?: emptyList()),
                poll = if (r.isDeleted) null else pollsByMsgId[r.id],
                proposal = if (r.isDeleted) null else proposalsByMsgId[r.id]
            )
        }
    }

    internal fun parsePollCommand(commandText: String): Pair<String, List<String>> {
        val rest = commandText.drop("/poll".length).trim()
        if (rest.isEmpty()) {
            throw ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Usage: /poll \"Question?\" \"Option 1\" \"Option 2\""
            )
        }

        val quotedParts = Regex("""["“]([^"”]+)["”]""")
            .findAll(rest)
            .map { it.groupValues[1].trim() }
            .filter { it.isNotEmpty() }
            .toList()

        val parts: List<String> = when {
            quotedParts.size >= 3 -> quotedParts
            rest.contains('|') -> rest.split('|').map { it.trim() }.filter { it.isNotEmpty() }
            quotedParts.size == 1 -> listOf(quotedParts[0], "Yes", "No")
            else -> emptyList()
        }

        if (parts.size < 3) {
            throw ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Poll requires a question and at least 2 options"
            )
        }

        val question = parts.first().take(240)
        val options = parts.drop(1).take(10).map { it.take(120) }
        return question to options
    }

    private data class MessageMembershipMeta(
        val messageId: Long,
        val podInternalId: Long,
        val podIdHex: String,
        val senderUserId: Long,
        val senderPeerId: String,
        val recipientPeerId: String?,
        val dmUserLowId: Long,
        val dmUserHighId: Long,
        val isDeleted: Boolean,
        val myAlias: String
    )

    private fun dispatchMessageFrame(meta: MessageMembershipMeta, frame: WsServerFrame) {
        if (meta.dmUserLowId > 0L) {
            podRealtimeHub.sendToUsers(meta.podIdHex, setOf(meta.dmUserLowId, meta.dmUserHighId), frame)
        } else {
            podRealtimeHub.broadcastToPod(meta.podIdHex, frame)
        }
    }

    private fun requireMessageAndMembership(userId: Long, messageId: Long): MessageMembershipMeta {
        return jdbcClient.sql(
            """
            SELECT m.id,
                   m.pod_id,
                   p.public_id AS pod_public_id,
                   m.sender_user_id,
                   su.public_id AS sender_public_id,
                   m.recipient_user_id,
                   ru.public_id AS recipient_public_id,
                   m.dm_user_low_id,
                   m.dm_user_high_id,
                   m.is_deleted,
                   pm.alias AS my_alias
            FROM messages m
            JOIN pods p ON p.id = m.pod_id
            LEFT JOIN users su ON su.id = m.sender_user_id
            LEFT JOIN users ru ON ru.id = m.recipient_user_id
            LEFT JOIN pod_members pm ON pm.pod_id = m.pod_id AND pm.user_id = :userId
            WHERE m.id = :messageId
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", userId)
            .param("messageId", messageId)
            .query(ResultSetExtractor { rs ->
                if (!rs.next()) {
                    throw ResponseStatusException(HttpStatus.NOT_FOUND, "Message not found")
                }
                val alias = rs.getString("my_alias")
                    ?: throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")

                val dmLow = rs.getLong("dm_user_low_id")
                val dmHigh = rs.getLong("dm_user_high_id")
                if (dmLow > 0L && userId != dmLow && userId != dmHigh) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Private message restricted to participants"
                    )
                }

                val podPub = rs.getBytes("pod_public_id")
                val senderUserId = rs.getLong("sender_user_id")
                val senderPub = rs.getBytes("sender_public_id")
                val recipientUserId = rs.getLong("recipient_user_id")
                val recipientPub = rs.getBytes("recipient_public_id")

                MessageMembershipMeta(
                    messageId = rs.getLong("id"),
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(podPub),
                    senderUserId = senderUserId,
                    senderPeerId = if (senderUserId > 0L && senderPub != null) UuidV7.peerId(podPub, senderPub) else "system",
                    recipientPeerId = if (recipientUserId > 0L && recipientPub != null) UuidV7.peerId(podPub, recipientPub) else null,
                    dmUserLowId = dmLow,
                    dmUserHighId = dmHigh,
                    isDeleted = rs.getInt("is_deleted") != 0,
                    myAlias = alias
                )
            })!!
    }

    private fun requirePodMembershipInternalId(userId: Long, podIdHexRaw: String): Long {
        val podPub = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        return jdbcClient.sql(
            """
            SELECT p.id
            FROM pods p
            JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPub
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", userId)
            .param("podPub", podPub)
            .query { rs, _ -> rs.getLong("id") }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod") }
    }

    private fun requirePodMemberContext(principal: AuthPrincipal, podIdHexRaw: String): PodMemberContext {
        val podPub = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        return jdbcClient.sql(
            """
            SELECT p.id AS pod_id,
                   p.public_id AS pod_public_id,
                   i.slug AS interest_slug,
                   pm.alias AS my_alias,
                   pm.alias_color AS my_color
            FROM pods p
            JOIN interests i ON i.id = p.interest_id
            LEFT JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPub
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .param("podPub", podPub)
            .query(ResultSetExtractor { rs ->
                if (!rs.next()) {
                    throw ResponseStatusException(HttpStatus.NOT_FOUND, "Pod not found")
                }
                val alias = rs.getString("my_alias")
                    ?: throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")
                val pBytes = rs.getBytes("pod_public_id")
                PodMemberContext(
                    podInternalId = rs.getLong("pod_id"),
                    podPublicBytes = pBytes,
                    podIdHex = UuidV7.toHex(pBytes),
                    interestSlug = rs.getString("interest_slug"),
                    myUserId = principal.userId(),
                    myPeerId = UuidV7.peerId(pBytes, principal.userPublicId()),
                    myAlias = alias,
                    myColor = rs.getString("my_color")
                )
            })!!
    }

    private fun resolveDmPeer(ctx: PodMemberContext, rawPeerId: String): DmPeerContext {
        val cleanPeerId = rawPeerId.trim()
        if (cleanPeerId.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid peerId")
        }

        data class MemberCandidate(val userId: Long, val peerId: String, val alias: String)
        val matched = jdbcClient.sql(
            """
            SELECT pm.user_id, u.public_id AS user_public_id, pm.alias
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id = :podId
            """.trimIndent()
        )
            .param("podId", ctx.podInternalId)
            .query { rs, _ ->
                MemberCandidate(
                    userId = rs.getLong("user_id"),
                    peerId = UuidV7.peerId(ctx.podPublicBytes, rs.getBytes("user_public_id")),
                    alias = rs.getString("alias")
                )
            }
            .list()
            .firstOrNull { it.peerId == cleanPeerId }
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Peer member not found in pod")

        if (matched.userId == ctx.myUserId) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot message yourself")
        }

        return DmPeerContext(
            peerUserId = matched.userId,
            peerId = matched.peerId,
            peerAlias = matched.alias,
            dmLow = minOf(ctx.myUserId, matched.userId),
            dmHigh = maxOf(ctx.myUserId, matched.userId)
        )
    }
}
