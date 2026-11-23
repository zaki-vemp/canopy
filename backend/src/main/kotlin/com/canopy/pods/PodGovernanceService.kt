package com.canopy.pods

import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.chat.RichChatService
import com.canopy.chat.RichMessageDto
import com.canopy.chat.SingleMessageResponse
import com.canopy.security.AuthPrincipal
import com.canopy.util.UuidV7
import com.canopy.ws.PodRealtimeHub
import com.canopy.ws.WsServerFrame
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.jdbc.support.GeneratedKeyHolder
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.server.ResponseStatusException

@Service
class PodGovernanceService(
    private val jdbcClient: JdbcClient,
    transactionManager: PlatformTransactionManager,
    private val objectMapper: ObjectMapper,
    private val podRealtimeHub: PodRealtimeHub,
    private val blindMatchService: BlindMatchService,
    private val richChatService: RichChatService,
    private val podProposalReader: PodProposalReader
) {
    private val log = LoggerFactory.getLogger(PodGovernanceService::class.java)
    private val txTemplate = TransactionTemplate(transactionManager)

    companion object {
        private val SUPPORTED_KINDS = setOf(
            "KICK_MEMBER",
            "RENAME_POD",
            "UPDATE_TOPIC",
            "CHANGE_CAPACITY",
            "TOGGLE_LOCK",
            "PIN_MESSAGE"
        )
    }

    private data class ExecutionEffects(
        val podInternalId: Long,
        val podIdHex: String,
        val announcementMessageId: Long = 0L,
        val announcementCreated: Boolean = false,
        val resolvedTransitioned: Boolean = false,
        val kickedMember: Pair<String, String>? = null,
        val pinnedMessageId: Long? = null,
        val systemMessage: RichMessageDto? = null
    )

    private data class ValidatedProposalSpec(
        val kind: String,
        val title: String,
        val payloadJson: String,
        val targetUserId: Long = 0L,
        val targetAlias: String = ""
    )

    fun listPodProposals(principal: AuthPrincipal, podIdHexRaw: String): List<PodProposalDto> {
        val podPub = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val podInternalId = jdbcClient.sql(
            """
            SELECT p.id
            FROM pods p
            JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPub
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .param("podPub", podPub)
            .query { rs, _ -> rs.getLong("id") }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod") }

        return podProposalReader.loadByPodId(podInternalId, principal.userId())
    }

    fun createProposal(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: CreateProposalRequest
    ): ProposalActionResponse {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val expiresMins = (req.expiresInMinutes ?: 5).coerceIn(1, 1440)

        val (proposalId, effects) = blindMatchService.executeWithDeadlockRetry {
            txTemplate.execute {
                val pod = blindMatchService.requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (pod.governanceMode != "DEMOCRATIC") {
                    throw ResponseStatusException(
                        HttpStatus.BAD_REQUEST,
                        "Proposals are only used in democratic pods"
                    )
                }

                val spec = validateAndBuildSpecTx(pod, principal.userId(), req)

                val eligibleCount = jdbcClient.sql("SELECT COUNT(*) FROM pod_members WHERE pod_id = :podId")
                    .param("podId", pod.podInternalId)
                    .query { rs, _ -> rs.getInt(1) }
                    .single()
                    .coerceAtLeast(1)

                val propKh = GeneratedKeyHolder()
                jdbcClient.sql(
                    """
                    INSERT INTO pod_proposals (
                        pod_id, proposer_user_id, proposer_alias, kind, title, payload_json,
                        target_user_id, target_alias, status, yes_count, no_count, eligible_count,
                        announcement_message_id, expires_at, created_at
                    ) VALUES (
                        :podId, :proposerUserId, :proposerAlias, :kind, :title, :payloadJson,
                        :targetUserId, :targetAlias, 'OPEN', 1, 0, :eligibleCount,
                        0, DATE_ADD(UTC_TIMESTAMP(), INTERVAL :mins MINUTE), UTC_TIMESTAMP()
                    )
                    """.trimIndent()
                )
                    .param("podId", pod.podInternalId)
                    .param("proposerUserId", principal.userId())
                    .param("proposerAlias", pod.alias)
                    .param("kind", spec.kind)
                    .param("title", spec.title)
                    .param("payloadJson", spec.payloadJson)
                    .param("targetUserId", spec.targetUserId)
                    .param("targetAlias", spec.targetAlias)
                    .param("eligibleCount", eligibleCount)
                    .param("mins", expiresMins)
                    .update(propKh)

                val createdPropId = propKh.key?.toLong()
                    ?: throw IllegalStateException("Failed to insert pod proposal")

                jdbcClient.sql(
                    """
                    INSERT INTO pod_proposal_votes (proposal_id, user_id, voter_alias, vote, created_at)
                    VALUES (:proposalId, :userId, :alias, 1, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("proposalId", createdPropId)
                    .param("userId", principal.userId())
                    .param("alias", pod.alias)
                    .update()

                val msgKh = GeneratedKeyHolder()
                jdbcClient.sql(
                    """
                    INSERT INTO messages (
                        pod_id, sender_user_id, sender_alias, sender_color,
                        recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id,
                        quote_message_id, msg_type, body, created_at
                    ) VALUES (
                        :podId, :userId, :alias, :color,
                        0, '', 0, 0,
                        0, 6, :body, UTC_TIMESTAMP()
                    )
                    """.trimIndent()
                )
                    .param("podId", pod.podInternalId)
                    .param("userId", principal.userId())
                    .param("alias", pod.alias)
                    .param("color", pod.color)
                    .param("body", spec.title)
                    .update(msgKh)

                val announcementMsgId = msgKh.key?.toLong() ?: 0L
                jdbcClient.sql("UPDATE pod_proposals SET announcement_message_id = :msgId WHERE id = :id")
                    .param("msgId", announcementMsgId)
                    .param("id", createdPropId)
                    .update()

                val evalEffects = evaluateAndResolveLockedTx(
                    proposalId = createdPropId,
                    podInternalId = pod.podInternalId,
                    podPublicBytes = pod.podPublicBytes,
                    podIdHex = pod.podIdHex,
                    forceExpired = false
                )

                createdPropId to evalEffects.copy(
                    announcementMessageId = announcementMsgId,
                    announcementCreated = true
                )
            }!!
        }

        val proposalDto = podProposalReader.loadById(proposalId, principal.userId())
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found")

        dispatchEffectsAfterCommit(proposalDto, effects, principal.userId())

        val userPod = runCatching { blindMatchService.getPodDetailForUser(principal, effects.podInternalId) }.getOrNull()
        val canonical = userPod ?: blindMatchService.buildCanonicalPodDetail(effects.podInternalId)
        if (canonical != null) {
            podRealtimeHub.broadcastPodUpdated(canonical)
        }
        return ProposalActionResponse(proposal = proposalDto, pod = userPod)
    }

    fun voteProposal(
        principal: AuthPrincipal,
        proposalId: Long,
        req: VoteProposalRequest
    ): ProposalActionResponse {
        val voteYes = req.vote
            ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "vote boolean is required")

        val podInternalIdLookup = jdbcClient.sql("SELECT pod_id FROM pod_proposals WHERE id = :id LIMIT 1")
            .param("id", proposalId)
            .query { rs, _ -> rs.getLong("pod_id") }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found") }

        val effects = blindMatchService.executeWithDeadlockRetry {
            txTemplate.execute {
                val podRow = lockPodForGovernanceTx(podInternalIdLookup)
                val callerAlias = jdbcClient.sql(
                    "SELECT alias FROM pod_members WHERE pod_id = :podId AND user_id = :userId LIMIT 1"
                )
                    .param("podId", podRow.first)
                    .param("userId", principal.userId())
                    .query(String::class.java)
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod") }

                val lockedProp = lockProposalRowTx(proposalId, podRow.first)
                if (lockedProp.status != "OPEN") {
                    throw ResponseStatusException(
                        HttpStatus.CONFLICT,
                        "This proposal has already been ${lockedProp.status.lowercase()}"
                    )
                }

                if (!lockedProp.isExpired) {
                    jdbcClient.sql(
                        """
                        INSERT INTO pod_proposal_votes (proposal_id, user_id, voter_alias, vote, created_at)
                        VALUES (:proposalId, :userId, :alias, :voteInt, UTC_TIMESTAMP())
                        ON DUPLICATE KEY UPDATE
                            vote = VALUES(vote),
                            voter_alias = VALUES(voter_alias),
                            created_at = UTC_TIMESTAMP()
                        """.trimIndent()
                    )
                        .param("proposalId", proposalId)
                        .param("userId", principal.userId())
                        .param("alias", callerAlias)
                        .param("voteInt", if (voteYes) 1 else 0)
                        .update()
                }

                evaluateAndResolveLockedTx(
                    proposalId = proposalId,
                    podInternalId = podRow.first,
                    podPublicBytes = podRow.second,
                    podIdHex = podRow.third,
                    forceExpired = lockedProp.isExpired
                )
            }!!
        }

        val proposalDto = podProposalReader.loadById(proposalId, principal.userId())
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found")

        dispatchEffectsAfterCommit(proposalDto, effects, principal.userId())

        val userPod = runCatching { blindMatchService.getPodDetailForUser(principal, effects.podInternalId) }.getOrNull()
        val canonical = userPod ?: blindMatchService.buildCanonicalPodDetail(effects.podInternalId)
        if (effects.resolvedTransitioned && canonical != null) {
            podRealtimeHub.broadcastPodUpdated(canonical)
        }
        return ProposalActionResponse(proposal = proposalDto, pod = userPod)
    }

    fun resolveProposal(principal: AuthPrincipal, proposalId: Long): ProposalActionResponse {
        val podInternalIdLookup = jdbcClient.sql("SELECT pod_id FROM pod_proposals WHERE id = :id LIMIT 1")
            .param("id", proposalId)
            .query { rs, _ -> rs.getLong("pod_id") }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found") }

        val effects = blindMatchService.executeWithDeadlockRetry {
            txTemplate.execute {
                val podRow = lockPodForGovernanceTx(podInternalIdLookup)
                val isMember = jdbcClient.sql(
                    "SELECT 1 FROM pod_members WHERE pod_id = :podId AND user_id = :userId LIMIT 1"
                )
                    .param("podId", podRow.first)
                    .param("userId", principal.userId())
                    .query(Int::class.java)
                    .optional()
                    .isPresent
                if (!isMember) {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")
                }

                val lockedProp = lockProposalRowTx(proposalId, podRow.first)
                if (lockedProp.status != "OPEN") {
                    return@execute ExecutionEffects(
                        podInternalId = podRow.first,
                        podIdHex = podRow.third,
                        announcementMessageId = lockedProp.announcementMessageId
                    )
                }

                evaluateAndResolveLockedTx(
                    proposalId = proposalId,
                    podInternalId = podRow.first,
                    podPublicBytes = podRow.second,
                    podIdHex = podRow.third,
                    forceExpired = lockedProp.isExpired
                )
            }!!
        }

        val proposalDto = podProposalReader.loadById(proposalId, principal.userId())
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found")

        if (effects.resolvedTransitioned) {
            dispatchEffectsAfterCommit(proposalDto, effects, principal.userId())
        }

        val userPod = runCatching { blindMatchService.getPodDetailForUser(principal, effects.podInternalId) }.getOrNull()
        val canonical = userPod ?: blindMatchService.buildCanonicalPodDetail(effects.podInternalId)
        if (effects.resolvedTransitioned && canonical != null) {
            podRealtimeHub.broadcastPodUpdated(canonical)
        }
        return ProposalActionResponse(proposal = proposalDto, pod = userPod)
    }

    @Scheduled(fixedDelay = 5000)
    fun resolveExpiredProposalsSweep() {
        val expiredRows = try {
            jdbcClient.sql(
                """
                SELECT id, pod_id
                FROM pod_proposals USE INDEX (idx_proposals_open_exp)
                WHERE status = 'OPEN'
                  AND expires_at <= UTC_TIMESTAMP()
                ORDER BY expires_at ASC
                LIMIT 50
                """.trimIndent()
            )
                .query { rs, _ -> rs.getLong("id") to rs.getLong("pod_id") }
                .list()
        } catch (ex: Exception) {
            log.debug("Proposal sweep skipped: {}", ex.message)
            return
        }

        for ((proposalId, podInternalId) in expiredRows) {
            try {
                val effects = blindMatchService.executeWithDeadlockRetry {
                    txTemplate.execute {
                        val podRow = lockPodForGovernanceTx(podInternalId)
                        val lockedProp = lockProposalRowTx(proposalId, podRow.first)
                        if (lockedProp.status != "OPEN") {
                            return@execute null
                        }
                        evaluateAndResolveLockedTx(
                            proposalId = proposalId,
                            podInternalId = podRow.first,
                            podPublicBytes = podRow.second,
                            podIdHex = podRow.third,
                            forceExpired = true
                        )
                    }
                } ?: continue

                if (effects.resolvedTransitioned) {
                    val proposalDto = podProposalReader.loadById(proposalId, 0L) ?: continue
                    dispatchEffectsAfterCommit(proposalDto, effects, 0L)
                    blindMatchService.buildCanonicalPodDetail(effects.podInternalId)?.let {
                        podRealtimeHub.broadcastPodUpdated(it)
                    }
                }
            } catch (ex: Exception) {
                log.warn("Failed resolving expired proposal {}: {}", proposalId, ex.message)
            }
        }
    }

    fun togglePinOrPropose(principal: AuthPrincipal, messageId: Long): SingleMessageResponse {
        data class PinCtx(
            val podInternalId: Long,
            val podIdHex: String,
            val governanceMode: String,
            val memberCount: Int,
            val dmUserLowId: Long,
            val dmUserHighId: Long,
            val isDeleted: Boolean,
            val myRole: String?
        )

        val ctx = jdbcClient.sql(
            """
            SELECT m.pod_id,
                   p.public_id AS pod_public_id,
                   p.governance_mode,
                   p.member_count,
                   m.dm_user_low_id,
                   m.dm_user_high_id,
                   m.is_deleted,
                   pm.role AS my_role
            FROM messages m
            JOIN pods p ON p.id = m.pod_id
            LEFT JOIN pod_members pm ON pm.pod_id = m.pod_id AND pm.user_id = :userId
            WHERE m.id = :messageId
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .param("messageId", messageId)
            .query { rs, _ ->
                PinCtx(
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(rs.getBytes("pod_public_id")),
                    governanceMode = rs.getString("governance_mode") ?: "DEMOCRATIC",
                    memberCount = rs.getInt("member_count"),
                    dmUserLowId = rs.getLong("dm_user_low_id"),
                    dmUserHighId = rs.getLong("dm_user_high_id"),
                    isDeleted = rs.getInt("is_deleted") != 0,
                    myRole = rs.getString("my_role")
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Message not found") }

        val role = ctx.myRole ?: throw ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod")

        if (ctx.dmUserLowId > 0L) {
            if (principal.userId() != ctx.dmUserLowId && principal.userId() != ctx.dmUserHighId) {
                throw ResponseStatusException(HttpStatus.FORBIDDEN, "Private message restricted to participants")
            }
            if (ctx.isDeleted) {
                throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot pin a deleted message")
            }
            return SingleMessageResponse(message = richChatService.togglePin(principal, messageId))
        }

        if (ctx.isDeleted) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot pin a deleted message")
        }

        if (ctx.governanceMode == "ADMIN") {
            if (role !in setOf("OWNER", "ADMIN")) {
                throw ResponseStatusException(HttpStatus.FORBIDDEN, "Only pod owners and admins can pin messages")
            }
            return SingleMessageResponse(message = richChatService.togglePin(principal, messageId))
        }

        // DEMOCRATIC pod: 1-member pod toggles immediately; multi-member pod uses YES vs NO vote!
        if (ctx.memberCount <= 1) {
            return SingleMessageResponse(message = richChatService.togglePin(principal, messageId))
        }

        val existingOpenPinPropId = findOpenPinProposalId(ctx.podInternalId, messageId)
        val propAction = if (existingOpenPinPropId != null) {
            voteProposal(principal, existingOpenPinPropId, VoteProposalRequest(vote = true))
        } else {
            createProposal(
                principal,
                ctx.podIdHex,
                CreateProposalRequest(kind = "PIN_MESSAGE", messageId = messageId)
            )
        }
        val freshMsg = richChatService.fetchSingleHydratedMessage(messageId, principal.userId())
        return SingleMessageResponse(message = freshMsg, proposal = propAction.proposal)
    }

    private fun findOpenPinProposalId(podInternalId: Long, messageId: Long): Long? {
        val openProps = jdbcClient.sql(
            """
            SELECT id, payload_json
            FROM pod_proposals
            WHERE pod_id = :podId
              AND kind = 'PIN_MESSAGE'
              AND status = 'OPEN'
              AND expires_at > UTC_TIMESTAMP()
            ORDER BY id DESC
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ -> rs.getLong("id") to (rs.getString("payload_json") ?: "{}") }
            .list()

        for ((id, json) in openProps) {
            val mid = runCatching { objectMapper.readTree(json).path("messageId").asLong(0L) }.getOrDefault(0L)
            if (mid == messageId) return id
        }
        return null
    }

    private data class LockedProposalRow(
        val id: Long,
        val kind: String,
        val title: String,
        val payloadJson: String,
        val targetUserId: Long,
        val targetAlias: String,
        val status: String,
        val announcementMessageId: Long,
        val isExpired: Boolean
    )

    private fun lockPodForGovernanceTx(podInternalId: Long): Triple<Long, ByteArray, String> {
        return jdbcClient.sql(
            "SELECT id, public_id FROM pods WHERE id = :id LIMIT 1 FOR UPDATE"
        )
            .param("id", podInternalId)
            .query { rs, _ ->
                val pub = rs.getBytes("public_id")
                Triple(rs.getLong("id"), pub, UuidV7.toHex(pub))
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Pod not found") }
    }

    private fun lockProposalRowTx(proposalId: Long, podInternalId: Long): LockedProposalRow {
        return jdbcClient.sql(
            """
            SELECT id,
                   kind,
                   title,
                   payload_json,
                   target_user_id,
                   target_alias,
                   status,
                   announcement_message_id,
                   CASE WHEN expires_at <= UTC_TIMESTAMP() THEN 1 ELSE 0 END AS is_expired
            FROM pod_proposals
            WHERE id = :id AND pod_id = :podId
            LIMIT 1
            FOR UPDATE
            """.trimIndent()
        )
            .param("id", proposalId)
            .param("podId", podInternalId)
            .query { rs, _ ->
                LockedProposalRow(
                    id = rs.getLong("id"),
                    kind = rs.getString("kind"),
                    title = rs.getString("title"),
                    payloadJson = rs.getString("payload_json") ?: "{}",
                    targetUserId = rs.getLong("target_user_id"),
                    targetAlias = rs.getString("target_alias") ?: "",
                    status = rs.getString("status"),
                    announcementMessageId = rs.getLong("announcement_message_id"),
                    isExpired = rs.getInt("is_expired") != 0
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Proposal not found") }
    }

    private fun evaluateAndResolveLockedTx(
        proposalId: Long,
        podInternalId: Long,
        podPublicBytes: ByteArray,
        podIdHex: String,
        forceExpired: Boolean
    ): ExecutionEffects {
        val prop = lockProposalRowTx(proposalId, podInternalId)
        if (prop.status != "OPEN") {
            return ExecutionEffects(
                podInternalId = podInternalId,
                podIdHex = podIdHex,
                announcementMessageId = prop.announcementMessageId
            )
        }

        val eligibleCount = jdbcClient.sql("SELECT COUNT(*) FROM pod_members WHERE pod_id = :podId")
            .param("podId", podInternalId)
            .query { rs, _ -> rs.getInt(1) }
            .single()
            .coerceAtLeast(1)

        val voteCounts = jdbcClient.sql(
            """
            SELECT COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) AS yes_cnt,
                   COALESCE(SUM(CASE WHEN v.vote = 0 THEN 1 ELSE 0 END), 0) AS no_cnt
            FROM pod_proposal_votes v
            JOIN pod_members pm ON pm.pod_id = :podId AND pm.user_id = v.user_id
            WHERE v.proposal_id = :proposalId
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .param("proposalId", proposalId)
            .query { rs, _ -> rs.getInt("yes_cnt") to rs.getInt("no_cnt") }
            .single()

        val yesCount = voteCounts.first
        val noCount = voteCounts.second
        val remaining = maxOf(0, eligibleCount - yesCount - noCount)
        val expiredNow = forceExpired || prop.isExpired

        val outcomeStatus: String? = when {
            yesCount > noCount + remaining -> "PASSED"
            yesCount + remaining <= noCount -> "REJECTED"
            expiredNow -> if (yesCount > noCount) "PASSED" else "REJECTED"
            else -> null
        }

        if (outcomeStatus == null) {
            jdbcClient.sql(
                """
                UPDATE pod_proposals
                SET yes_count = :yesCount,
                    no_count = :noCount,
                    eligible_count = :eligibleCount
                WHERE id = :id
                """.trimIndent()
            )
                .param("yesCount", yesCount)
                .param("noCount", noCount)
                .param("eligibleCount", eligibleCount)
                .param("id", proposalId)
                .update()

            return ExecutionEffects(
                podInternalId = podInternalId,
                podIdHex = podIdHex,
                announcementMessageId = prop.announcementMessageId,
                resolvedTransitioned = false
            )
        }

        jdbcClient.sql(
            """
            UPDATE pod_proposals
            SET status = :status,
                 yes_count = :yesCount,
                no_count = :noCount,
                eligible_count = :eligibleCount,
                resolved_at = UTC_TIMESTAMP()
            WHERE id = :id
            """.trimIndent()
        )
            .param("status", outcomeStatus)
            .param("yesCount", yesCount)
            .param("noCount", noCount)
            .param("eligibleCount", eligibleCount)
            .param("id", proposalId)
            .update()

        if (outcomeStatus == "REJECTED") {
            val sysMsg = blindMatchService.insertSystemMessageAndBuildDto(
                podInternalId,
                podIdHex,
                "Vote did not pass ($yesCount Yes – $noCount No): ${prop.title}"
            )
            return ExecutionEffects(
                podInternalId = podInternalId,
                podIdHex = podIdHex,
                announcementMessageId = prop.announcementMessageId,
                resolvedTransitioned = true,
                systemMessage = sysMsg
            )
        }

        return executePassedProposalActionTx(
            prop = prop,
            podInternalId = podInternalId,
            podPublicBytes = podPublicBytes,
            podIdHex = podIdHex,
            yesCount = yesCount,
            noCount = noCount
        )
    }

    private fun executePassedProposalActionTx(
        prop: LockedProposalRow,
        podInternalId: Long,
        podPublicBytes: ByteArray,
        podIdHex: String,
        yesCount: Int,
        noCount: Int
    ): ExecutionEffects {
        val payload = runCatching { objectMapper.readTree(prop.payloadJson) }.getOrNull()
        val tally = "Vote passed ($yesCount Yes – $noCount No)"

        return when (prop.kind) {
            "KICK_MEMBER" -> {
                val targetUserId = prop.targetUserId
                val targetUserPub = jdbcClient.sql("SELECT public_id FROM users WHERE id = :id LIMIT 1")
                    .param("id", targetUserId)
                    .query { rs, _ -> rs.getBytes("public_id") }
                    .optional()
                    .orElse(null)
                val targetPeerId = if (targetUserPub != null) {
                    UuidV7.peerId(podPublicBytes, targetUserPub)
                } else {
                    payload?.path("targetPeerId")?.asText("") ?: ""
                }

                val deleted = jdbcClient.sql("DELETE FROM pod_members WHERE pod_id = :podId AND user_id = :uid")
                    .param("podId", podInternalId)
                    .param("uid", targetUserId)
                    .update()

                if (deleted > 0) {
                    jdbcClient.sql(
                        """
                        UPDATE pods
                        SET is_open = CASE WHEN member_count > 1 AND (member_count - 1) < max_members THEN 1 ELSE 0 END,
                            member_count = CASE WHEN member_count > 0 THEN member_count - 1 ELSE 0 END
                        WHERE id = :podId
                        """.trimIndent()
                    )
                        .param("podId", podInternalId)
                        .update()

                    jdbcClient.sql(
                        """
                        INSERT INTO pod_opt_outs (user_id, pod_id, left_at)
                        VALUES (:userId, :podId, UTC_TIMESTAMP())
                        ON DUPLICATE KEY UPDATE left_at = UTC_TIMESTAMP()
                        """.trimIndent()
                    )
                        .param("userId", targetUserId)
                        .param("podId", podInternalId)
                        .update()
                }

                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: ${prop.targetAlias} was removed from the pod"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    kickedMember = if (deleted > 0 && targetPeerId.isNotBlank()) targetPeerId to prop.targetAlias else null,
                    systemMessage = sys
                )
            }

            "RENAME_POD" -> {
                val newTitle = (payload?.path("label")?.asText("") ?: "").trim().take(80)
                val newDesc = (payload?.path("topic")?.asText("") ?: "").trim().take(280)
                if (newTitle.isNotEmpty()) {
                    if (newDesc.isNotEmpty()) {
                        jdbcClient.sql("UPDATE pods SET title = :title, description = :desc WHERE id = :id")
                            .param("title", newTitle)
                            .param("desc", newDesc)
                            .param("id", podInternalId)
                            .update()
                    } else {
                        jdbcClient.sql("UPDATE pods SET title = :title WHERE id = :id")
                            .param("title", newTitle)
                            .param("id", podInternalId)
                            .update()
                    }
                }
                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: pod renamed to $newTitle"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    systemMessage = sys
                )
            }

            "UPDATE_TOPIC" -> {
                val newTopic = (payload?.path("topic")?.asText("") ?: "").trim().take(280)
                jdbcClient.sql("UPDATE pods SET description = :desc WHERE id = :id")
                    .param("desc", newTopic)
                    .param("id", podInternalId)
                    .update()
                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: updated pod topic"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    systemMessage = sys
                )
            }

            "CHANGE_CAPACITY" -> {
                val newMax = payload?.path("maxMembers")?.asInt(25) ?: 25
                if (newMax in BlindMatchService.ALLOWED_MAX_MEMBERS) {
                    jdbcClient.sql(
                        """
                        UPDATE pods
                        SET max_members = :maxMembers,
                            is_open = CASE WHEN member_count < :maxMembers THEN 1 ELSE 0 END
                        WHERE id = :id
                        """.trimIndent()
                    )
                        .param("maxMembers", newMax)
                        .param("id", podInternalId)
                        .update()
                }
                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: pod capacity updated to $newMax members"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    systemMessage = sys
                )
            }

            "TOGGLE_LOCK" -> {
                val locked = payload?.path("locked")?.asBoolean(false) ?: false
                if (locked) {
                    jdbcClient.sql("UPDATE pods SET is_open = 0 WHERE id = :id")
                        .param("id", podInternalId)
                        .update()
                } else {
                    jdbcClient.sql(
                        "UPDATE pods SET is_open = CASE WHEN member_count < max_members THEN 1 ELSE 0 END WHERE id = :id"
                    )
                        .param("id", podInternalId)
                        .update()
                }
                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: pod ${if (locked) "locked" else "unlocked"}"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    systemMessage = sys
                )
            }

            "PIN_MESSAGE" -> {
                val msgId = payload?.path("messageId")?.asLong(0L) ?: 0L
                var nowPinned = true
                if (msgId > 0L) {
                    jdbcClient.sql(
                        """
                        UPDATE messages
                        SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END
                        WHERE id = :msgId AND pod_id = :podId AND dm_user_low_id = 0 AND is_deleted = 0
                        """.trimIndent()
                    )
                        .param("msgId", msgId)
                        .param("podId", podInternalId)
                        .update()

                    nowPinned = jdbcClient.sql("SELECT is_pinned FROM messages WHERE id = :id LIMIT 1")
                        .param("id", msgId)
                        .query { rs, _ -> rs.getInt("is_pinned") != 0 }
                        .optional()
                        .orElse(false)
                }
                val sys = blindMatchService.insertSystemMessageAndBuildDto(
                    podInternalId,
                    podIdHex,
                    "$tally: ${if (nowPinned) "pinned" else "unpinned"} message #$msgId"
                )
                ExecutionEffects(
                    podInternalId = podInternalId,
                    podIdHex = podIdHex,
                    announcementMessageId = prop.announcementMessageId,
                    resolvedTransitioned = true,
                    pinnedMessageId = if (msgId > 0L) msgId else null,
                    systemMessage = sys
                )
            }

            else -> ExecutionEffects(
                podInternalId = podInternalId,
                podIdHex = podIdHex,
                announcementMessageId = prop.announcementMessageId,
                resolvedTransitioned = true
            )
        }
    }

    private fun validateAndBuildSpecTx(
        pod: BlindMatchService.LockedMemberPodLookup,
        callerUserId: Long,
        req: CreateProposalRequest
    ): ValidatedProposalSpec {
        val kind = req.kind.trim().uppercase()
        if (kind !in SUPPORTED_KINDS) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported proposal kind: ${req.kind}")
        }
        val cleanReason = (req.reason ?: "").trim().take(240)

        return when (kind) {
            "KICK_MEMBER" -> {
                val peerId = (req.targetPeerId ?: "").trim()
                if (peerId.isEmpty()) {
                    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "targetPeerId is required for KICK_MEMBER")
                }
                val target = blindMatchService.findPodMemberByPeerId(pod.podInternalId, pod.podPublicBytes, peerId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Target member not found in pod")
                if (target.userId == callerUserId) {
                    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot propose kicking yourself")
                }

                val dup = jdbcClient.sql(
                    """
                    SELECT 1
                    FROM pod_proposals
                    WHERE pod_id = :podId
                      AND kind = 'KICK_MEMBER'
                      AND target_user_id = :targetUid
                      AND status = 'OPEN'
                      AND expires_at > UTC_TIMESTAMP()
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("podId", pod.podInternalId)
                    .param("targetUid", target.userId)
                    .query(Int::class.java)
                    .optional()
                    .isPresent
                if (dup) {
                    throw ResponseStatusException(
                        HttpStatus.CONFLICT,
                        "An open vote to remove ${target.alias} is already in progress"
                    )
                }

                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "targetPeerId" to target.peerId)
                )
                ValidatedProposalSpec(
                    kind = kind,
                    title = "Kick ${target.alias} from pod",
                    payloadJson = payload,
                    targetUserId = target.userId,
                    targetAlias = target.alias
                )
            }

            "RENAME_POD" -> {
                val newTitle = (req.label ?: "").trim().take(80)
                if (newTitle.isEmpty()) {
                    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "New pod title is required")
                }
                val newDesc = (req.topic ?: req.description ?: "").trim().take(280)
                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "label" to newTitle, "topic" to newDesc)
                )
                ValidatedProposalSpec(
                    kind = kind,
                    title = "Rename pod to \"$newTitle\"".take(180),
                    payloadJson = payload
                )
            }

            "UPDATE_TOPIC" -> {
                val rawTopic = req.topic ?: req.description
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "topic is required")
                val newTopic = rawTopic.trim().take(280)
                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "topic" to newTopic)
                )
                val title = if (newTopic.isEmpty()) {
                    "Clear pod topic"
                } else {
                    "Update pod topic to \"${newTopic.take(80)}\""
                }
                ValidatedProposalSpec(
                    kind = kind,
                    title = title.take(180),
                    payloadJson = payload
                )
            }

            "CHANGE_CAPACITY" -> {
                val newMax = req.maxMembers
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "maxMembers is required")
                blindMatchService.validateMaxMembers(newMax)
                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "maxMembers" to newMax)
                )
                ValidatedProposalSpec(
                    kind = kind,
                    title = "Change pod capacity to $newMax members",
                    payloadJson = payload
                )
            }

            "TOGGLE_LOCK" -> {
                val locked = req.locked
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "locked boolean is required")
                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "locked" to locked)
                )
                ValidatedProposalSpec(
                    kind = kind,
                    title = if (locked) "Lock pod to new members" else "Unlock pod for new members",
                    payloadJson = payload
                )
            }

            "PIN_MESSAGE" -> {
                val msgId = req.messageId
                    ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "messageId is required")
                if (findOpenPinProposalId(pod.podInternalId, msgId) != null) {
                    throw ResponseStatusException(
                        HttpStatus.CONFLICT,
                        "An open pin vote for message #$msgId is already in progress"
                    )
                }
                val isPinned = jdbcClient.sql(
                    """
                    SELECT is_pinned
                    FROM messages
                    WHERE id = :id
                      AND pod_id = :podId
                      AND dm_user_low_id = 0
                      AND is_deleted = 0
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("id", msgId)
                    .param("podId", pod.podInternalId)
                    .query { rs, _ -> rs.getInt("is_pinned") != 0 }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Group message not found in pod") }

                val payload = objectMapper.writeValueAsString(
                    mapOf("reason" to cleanReason, "messageId" to msgId)
                )
                ValidatedProposalSpec(
                    kind = kind,
                    title = if (isPinned) "Unpin message #$msgId" else "Pin message #$msgId",
                    payloadJson = payload
                )
            }

            else -> throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported proposal kind")
        }
    }

    private fun dispatchEffectsAfterCommit(
        proposalDto: PodProposalDto,
        effects: ExecutionEffects,
        callerUserId: Long
    ) {
        if (effects.announcementMessageId > 0L) {
            runCatching {
                val msg = richChatService.fetchSingleHydratedMessage(effects.announcementMessageId, callerUserId)
                if (effects.announcementCreated) {
                    podRealtimeHub.broadcastToPod(effects.podIdHex, WsServerFrame.MessageCreatedOut(message = msg))
                } else {
                    podRealtimeHub.broadcastToPod(effects.podIdHex, WsServerFrame.MessageUpdatedOut(message = msg))
                }
            }
        }

        podRealtimeHub.broadcastToPod(
            effects.podIdHex,
            WsServerFrame.ProposalUpdatedOut(proposal = proposalDto)
        )

        effects.kickedMember?.let { (peerId, alias) ->
            podRealtimeHub.broadcastToPod(
                effects.podIdHex,
                WsServerFrame.MemberKickedOut(peerId = peerId, alias = alias)
            )
            podRealtimeHub.evictMember(effects.podIdHex, peerId, alias)
        }

        effects.pinnedMessageId?.let { mid ->
            runCatching {
                val pinnedMsg = richChatService.fetchSingleHydratedMessage(mid, callerUserId)
                podRealtimeHub.broadcastToPod(effects.podIdHex, WsServerFrame.PinUpdatedOut(message = pinnedMsg))
            }
        }

        effects.systemMessage?.let { sysMsg ->
            podRealtimeHub.broadcastToPod(effects.podIdHex, WsServerFrame.MessageCreatedOut(message = sysMsg))
        }
    }
}
