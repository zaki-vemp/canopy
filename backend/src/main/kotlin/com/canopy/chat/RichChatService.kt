package com.canopy.chat

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
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

    private data class PodChannelContext(
        val podInternalId: Long,
        val podPublicBytes: ByteArray,
        val podIdHex: String,
        val interestSlug: String,
        val channelInternalId: Long,
        val channelIdHex: String,
        val channelKind: Int,
        val myAlias: String,
        val myColor: String
    )

    private data class RawMessageRow(
        val id: Long,
        val podInternalId: Long,
        val podPublicBytes: ByteArray,
        val channelPublicBytes: ByteArray,
        val senderUserId: Long,
        val senderUserPublicBytes: ByteArray?,
        val senderAlias: String,
        val senderColor: String,
        val parentMessageId: Long,
        val quoteMessageId: Long,
        val msgType: Int,
        val body: String,
        val replyCount: Int,
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
            channelPublicBytes = rs.getBytes("channel_public_id"),
            senderUserId = rs.getLong("sender_user_id"),
            senderUserPublicBytes = rs.getBytes("sender_public_id"),
            senderAlias = rs.getString("sender_alias"),
            senderColor = rs.getString("sender_color"),
            parentMessageId = rs.getLong("parent_message_id"),
            quoteMessageId = rs.getLong("quote_message_id"),
            msgType = rs.getInt("msg_type"),
            body = rs.getString("body") ?: "",
            replyCount = rs.getInt("reply_count"),
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
               c.public_id AS channel_public_id,
               m.sender_user_id,
               u.public_id AS sender_public_id,
               m.sender_alias,
               m.sender_color,
               m.parent_message_id,
               m.quote_message_id,
               m.msg_type,
               m.body,
               m.reply_count,
               m.is_pinned,
               m.is_deleted,
               m.edited_at,
               m.created_at
        FROM messages m $indexHint
        JOIN pods p ON p.id = m.pod_id
        JOIN pod_channels c ON c.id = m.channel_id
        LEFT JOIN users u ON u.id = m.sender_user_id
    """.trimIndent()

    private val baseMessageSelect = selectFromMessages()
    private val channelCursorSelect = selectFromMessages("FORCE INDEX (idx_messages_channel_cursor)")

    fun listChannelMessages(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        channelIdHexRaw: String,
        beforeId: Long,
        limit: Int
    ): MessagesPageResponse {
        val ctx = requirePodChannelContext(principal.userId(), podIdHexRaw, channelIdHexRaw)
        val safeLimit = limit.coerceIn(1, 100)
        val fetchLimit = safeLimit + 1

        val rowsDesc = if (beforeId > 0L) {
            jdbcClient.sql(
                """
                $channelCursorSelect
                WHERE m.channel_id = :channelId
                  AND m.parent_message_id = 0
                  AND m.id < :beforeId
                ORDER BY m.id DESC
                LIMIT :fetchLimit
                """.trimIndent()
            )
                .param("channelId", ctx.channelInternalId)
                .param("beforeId", beforeId)
                .param("fetchLimit", fetchLimit)
                .query(rawMessageMapper)
                .list()
        } else {
            jdbcClient.sql(
                """
                $channelCursorSelect
                WHERE m.channel_id = :channelId
                  AND m.parent_message_id = 0
                ORDER BY m.id DESC
                LIMIT :fetchLimit
                """.trimIndent()
            )
                .param("channelId", ctx.channelInternalId)
                .param("fetchLimit", fetchLimit)
                .query(rawMessageMapper)
                .list()
        }

        val hasMore = rowsDesc.size > safeLimit
        val pageDesc = if (hasMore) rowsDesc.take(safeLimit) else rowsDesc
        val chronological = pageDesc.asReversed()
        val nextBeforeId = if (hasMore && chronological.isNotEmpty()) chronological.first().id else 0L

        val hydrated = hydrateMessages(chronological, principal.userId())
        return MessagesPageResponse(messages = hydrated, nextBeforeId = nextBeforeId)
    }

    fun getThread(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        channelIdHexRaw: String,
        parentMessageId: Long
    ): ThreadResponse {
        val ctx = requirePodChannelContext(principal.userId(), podIdHexRaw, channelIdHexRaw)

        val parentRow = jdbcClient.sql(
            """
            $baseMessageSelect
            WHERE m.id = :parentId
              AND m.pod_id = :podId
              AND m.channel_id = :channelId
            LIMIT 1
            """.trimIndent()
        )
            .param("parentId", parentMessageId)
            .param("podId", ctx.podInternalId)
            .param("channelId", ctx.channelInternalId)
            .query(rawMessageMapper)
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Thread parent message not found") }

        val replyRows = jdbcClient.sql(
            """
            $baseMessageSelect
            WHERE m.parent_message_id = :parentId
              AND m.pod_id = :podId
            ORDER BY m.id ASC
            LIMIT 200
            """.trimIndent()
        )
            .param("parentId", parentMessageId)
            .param("podId", ctx.podInternalId)
            .query(rawMessageMapper)
            .list()

        val allHydrated = hydrateMessages(listOf(parentRow) + replyRows, principal.userId())
        return ThreadResponse(
            parent = allHydrated.first(),
            replies = allHydrated.drop(1)
        )
    }

    fun sendMessage(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        channelIdHexRaw: String,
        req: SendMessageRequest
    ): SendMessageResponse {
        val ctx = requirePodChannelContext(principal.userId(), podIdHexRaw, channelIdHexRaw)
        val trimmed = req.body.trim()

        // Slash command: /status <text>
        if (trimmed.equals("/status", ignoreCase = true) || trimmed.startsWith("/status ", ignoreCase = true)) {
            val newStatus = trimmed.drop("/status".length).trim().take(80)
            jdbcClient.sql("UPDATE pod_members SET custom_status = :status WHERE pod_id = :podId AND user_id = :userId")
                .param("status", newStatus)
                .param("podId", ctx.podInternalId)
                .param("userId", principal.userId())
                .update()
            podRealtimeHub.clearTyping(ctx.podIdHex, ctx.channelIdHex, ctx.myAlias)
            podRealtimeHub.broadcastPresenceSnapshot(ctx.podInternalId, ctx.podIdHex)
            return SendMessageResponse(message = null, commandHandled = "status")
        }

        var msgType = 1 // TEXT
        var effectiveBody = req.body.trim()
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

        val newMessageId = txTemplate.execute {
            // Validate parent thread message if replying
            if (req.parentMessageId > 0L) {
                val validParent = jdbcClient.sql(
                    """
                    SELECT id
                    FROM messages
                    WHERE id = :parentId
                      AND pod_id = :podId
                      AND channel_id = :channelId
                      AND parent_message_id = 0
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("parentId", req.parentMessageId)
                    .param("podId", ctx.podInternalId)
                    .param("channelId", ctx.channelInternalId)
                    .query { rs, _ -> rs.getLong("id") }
                    .optional()
                    .orElse(null)
                if (validParent == null) {
                    throw ResponseStatusException(HttpStatus.NOT_FOUND, "Parent message not found in channel")
                }
            }

            // Validate quote message belongs to same pod
            var validQuoteId = 0L
            if (req.quoteMessageId > 0L) {
                validQuoteId = jdbcClient.sql(
                    "SELECT id FROM messages WHERE id = :qid AND pod_id = :podId LIMIT 1"
                )
                    .param("qid", req.quoteMessageId)
                    .param("podId", ctx.podInternalId)
                    .query { rs, _ -> rs.getLong("id") }
                    .optional()
                    .orElse(0L)
            }

            // Inspect unlinked caller attachments in this pod
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
                    .param("userId", principal.userId())
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
                    pod_id, channel_id, sender_user_id, sender_alias, sender_color,
                    parent_message_id, quote_message_id, msg_type, body, created_at
                ) VALUES (
                    :podId, :channelId, :userId, :alias, :color,
                    :parentId, :quoteId, :msgType, :body, UTC_TIMESTAMP()
                )
                """.trimIndent()
            )
                .param("podId", ctx.podInternalId)
                .param("channelId", ctx.channelInternalId)
                .param("userId", principal.userId())
                .param("alias", ctx.myAlias)
                .param("color", ctx.myColor)
                .param("parentId", req.parentMessageId.coerceAtLeast(0L))
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
                    .param("userId", principal.userId())
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

            if (req.parentMessageId > 0L) {
                jdbcClient.sql("UPDATE messages SET reply_count = reply_count + 1 WHERE id = :parentId")
                    .param("parentId", req.parentMessageId)
                    .update()
            }

            insertedMsgId
        }!!

        podRealtimeHub.clearTyping(ctx.podIdHex, ctx.channelIdHex, ctx.myAlias)

        if (req.parentMessageId > 0L) {
            val both = fetchAndHydrateByIds(listOf(newMessageId, req.parentMessageId), principal.userId())
            val replyDto = both[newMessageId]
                ?: throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Created reply missing")
            val parentDto = both[req.parentMessageId]

            podRealtimeHub.broadcastFrame(
                ctx.podIdHex,
                WsServerFrame.ThreadReplyCreatedOut(
                    channelId = ctx.channelIdHex,
                    parentMessageId = req.parentMessageId,
                    reply = replyDto,
                    parentReplyCount = parentDto?.replyCount ?: 1
                )
            )
            if (parentDto != null) {
                podRealtimeHub.broadcastFrame(
                    ctx.podIdHex,
                    WsServerFrame.MessageUpdatedOut(channelId = ctx.channelIdHex, message = parentDto)
                )
            }
            return SendMessageResponse(message = replyDto)
        } else {
            val newDto = fetchSingleHydratedMessage(newMessageId, principal.userId())
            podRealtimeHub.broadcastFrame(
                ctx.podIdHex,
                WsServerFrame.MessageCreatedOut(channelId = ctx.channelIdHex, message = newDto)
            )
            return SendMessageResponse(message = newDto)
        }
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
        podRealtimeHub.broadcastFrame(
            meta.podIdHex,
            WsServerFrame.MessageUpdatedOut(channelId = updated.channelId, message = updated)
        )
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

        podRealtimeHub.broadcastFrame(
            meta.podIdHex,
            WsServerFrame.MessageDeletedOut(
                channelId = meta.channelIdHex,
                messageId = messageId,
                parentMessageId = meta.parentMessageId
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
        podRealtimeHub.broadcastFrame(
            meta.podIdHex,
            WsServerFrame.ReactionUpdatedOut(channelId = updated.channelId, message = updated)
        )
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
        podRealtimeHub.broadcastFrame(
            meta.podIdHex,
            WsServerFrame.PinUpdatedOut(channelId = updated.channelId, message = updated)
        )
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
            val myAlias: String
        )

        val lookup = jdbcClient.sql(
            """
            SELECT pl.id AS poll_id,
                   pl.message_id,
                   pl.options_json,
                   pl.is_closed,
                   m.pod_id,
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
                PollLookup(
                    pollId = rs.getLong("poll_id"),
                    messageId = rs.getLong("message_id"),
                    optionsJson = rs.getString("options_json"),
                    isClosed = rs.getInt("is_closed") != 0,
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(rs.getBytes("pod_public_id")),
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
        podRealtimeHub.broadcastFrame(
            lookup.podIdHex,
            WsServerFrame.PollUpdatedOut(channelId = updated.channelId, message = updated)
        )
        return updated
    }

    fun listPodPins(principal: AuthPrincipal, podIdHexRaw: String): List<RichMessageDto> {
        val podInternalId = requirePodMembershipInternalId(principal.userId(), podIdHexRaw)
        val rows = jdbcClient.sql(
            """
            $baseMessageSelect
            WHERE m.pod_id = :podId
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

        // Extract word tokens the same way InnoDB FULLTEXT tokenizes utf8mb4 text
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
                  AND MATCH(m.body) AGAINST(:booleanQuery IN BOOLEAN MODE)
                ORDER BY m.id DESC
                LIMIT 50
                """.trimIndent()
            )
                .param("podId", podInternalId)
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
                  AND m.body LIKE :likePattern
                ORDER BY m.id DESC
                LIMIT 50
                """.trimIndent()
            )
                .param("podId", podInternalId)
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
     * and polls + poll votes in flat IN(...) queries (zero N+1 queries per mysql/references/n-plus-one.md).
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

        // 4. Batch fetch quoted snippets
        val quoteIds = rows.map { it.quoteMessageId }.filter { it > 0L }.distinct()
        val quotesById = HashMap<Long, QuoteSnippetDto>()
        if (quoteIds.isNotEmpty()) {
            jdbcClient.sql(
                """
                SELECT m.id,
                       p.public_id AS pod_public_id,
                       m.sender_user_id,
                       u.public_id AS sender_public_id,
                       m.sender_alias,
                       m.sender_color,
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
                    quotesById[qid] = QuoteSnippetDto(
                        id = qid,
                        senderPeerId = senderPeerId,
                        senderAlias = rs.getString("sender_alias"),
                        senderColor = rs.getString("sender_color"),
                        body = if (deleted) "" else (rs.getString("body") ?: "").take(240),
                        msgType = msgTypeToName(rs.getInt("msg_type")),
                        isDeleted = deleted
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

        // 6. Batch fetch governance proposals (pod-scoped for index & single-shard routing, zero N+1)
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
            val chHex = UuidV7.toHex(r.channelPublicBytes)
            val senderPeerId = if (r.senderUserId > 0L && r.senderUserPublicBytes != null) {
                UuidV7.peerId(r.podPublicBytes, r.senderUserPublicBytes)
            } else {
                "system"
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

            RichMessageDto(
                id = r.id,
                podId = podHex,
                channelId = chHex,
                senderPeerId = senderPeerId,
                senderAlias = r.senderAlias,
                senderColor = r.senderColor,
                parentMessageId = r.parentMessageId,
                quoteMessage = if (r.quoteMessageId > 0L) quotesById[r.quoteMessageId] else null,
                msgType = msgTypeToName(r.msgType),
                body = if (r.isDeleted) "" else r.body,
                replyCount = r.replyCount,
                isPinned = r.isPinned,
                isBookmarked = r.id in bookmarkedMsgIds,
                isDeleted = r.isDeleted,
                editedAtIsoOrNull(r),
                createdAt = r.createdAtIso,
                reactions = reactionDtos,
                attachments = if (r.isDeleted) emptyList() else (attachmentsByMsg[r.id] ?: emptyList()),
                poll = if (r.isDeleted) null else pollsByMsgId[r.id],
                proposal = if (r.isDeleted) null else proposalsByMsgId[r.id]
            )
        }
    }

    private fun editedAtIsoOrNull(r: RawMessageRow): String? = r.editedAtIso

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
        val channelIdHex: String,
        val senderUserId: Long,
        val parentMessageId: Long,
        val isDeleted: Boolean,
        val myAlias: String
    )

    private fun requireMessageAndMembership(userId: Long, messageId: Long): MessageMembershipMeta {
        return jdbcClient.sql(
            """
            SELECT m.id,
                   m.pod_id,
                   p.public_id AS pod_public_id,
                   c.public_id AS channel_public_id,
                   m.sender_user_id,
                   m.parent_message_id,
                   m.is_deleted,
                   pm.alias AS my_alias
            FROM messages m
            JOIN pods p ON p.id = m.pod_id
            JOIN pod_channels c ON c.id = m.channel_id
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
                MessageMembershipMeta(
                    messageId = rs.getLong("id"),
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(rs.getBytes("pod_public_id")),
                    channelIdHex = UuidV7.toHex(rs.getBytes("channel_public_id")),
                    senderUserId = rs.getLong("sender_user_id"),
                    parentMessageId = rs.getLong("parent_message_id"),
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

    private fun requirePodChannelContext(
        userId: Long,
        podIdHexRaw: String,
        channelIdHexRaw: String
    ): PodChannelContext {
        val podPub = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val chPub = parsePublicIdOrBadRequest(channelIdHexRaw, "channelId")

        return jdbcClient.sql(
            """
            SELECT p.id AS pod_id,
                   p.public_id AS pod_public_id,
                   i.slug AS interest_slug,
                   c.id AS channel_id,
                   c.public_id AS channel_public_id,
                   c.kind AS channel_kind,
                   pm.alias AS my_alias,
                   pm.alias_color AS my_color
            FROM pods p
            JOIN interests i ON i.id = p.interest_id
            JOIN pod_channels c ON c.pod_id = p.id AND c.public_id = :chPub
            LEFT JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPub
            LIMIT 1
            """.trimIndent()
        )
            .param("chPub", chPub)
            .param("userId", userId)
            .param("podPub", podPub)
            .query(ResultSetExtractor { rs ->
                if (!rs.next()) {
                    throw ResponseStatusException(HttpStatus.NOT_FOUND, "Pod or channel not found")
                }
                val alias = rs.getString("my_alias")
                    ?: throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")
                val pBytes = rs.getBytes("pod_public_id")
                val cBytes = rs.getBytes("channel_public_id")
                PodChannelContext(
                    podInternalId = rs.getLong("pod_id"),
                    podPublicBytes = pBytes,
                    podIdHex = UuidV7.toHex(pBytes),
                    interestSlug = rs.getString("interest_slug"),
                    channelInternalId = rs.getLong("channel_id"),
                    channelIdHex = UuidV7.toHex(cBytes),
                    channelKind = rs.getInt("channel_kind"),
                    myAlias = alias,
                    myColor = rs.getString("my_color")
                )
            })!!
    }
}
