package com.canopy.pods

import com.canopy.chat.RichMessageDto
import com.canopy.security.AuthPrincipal
import com.canopy.util.UuidV7
import com.canopy.ws.PodRealtimeHub
import com.canopy.ws.WsServerFrame
import org.springframework.dao.CannotAcquireLockException
import org.springframework.dao.DataAccessException
import org.springframework.dao.PessimisticLockingFailureException
import org.springframework.http.HttpStatus
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.jdbc.support.GeneratedKeyHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.server.ResponseStatusException
import java.security.SecureRandom
import java.sql.SQLException
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

@Service
class BlindMatchService(
    private val jdbcClient: JdbcClient,
    transactionManager: PlatformTransactionManager,
    private val podRealtimeHub: PodRealtimeHub
) {
    private val txTemplate = TransactionTemplate(transactionManager)
    private val rng = SecureRandom()

    companion object {
        private val ADJECTIVES = listOf(
            "Amber", "Cobalt", "Cedar", "Slate", "Mint", "Coral",
            "Flint", "Ochre", "Birch", "Jade", "Teal", "Quartz"
        )
        private val NOUNS = listOf(
            "Fox", "Heron", "Otter", "Owl", "Finch", "Lynx",
            "Badger", "Wren", "Falcon", "Ibis", "Marten", "Seal"
        )
        private val COLORS = listOf(
            "#1f6b3a", "#0f766e", "#1d4ed8", "#b45309", "#be123c", "#334155"
        )
        private const val SYSTEM_ALIAS = "System"
        private const val SYSTEM_COLOR = "#334155"
        internal val ALLOWED_MAX_MEMBERS = setOf(4, 6, 10, 25, 50)
        private const val DEFAULT_MAX_MEMBERS = 25
        // ponytail: cap at 8 active pods per interest per user in v1 to bound realtime fanout; raise if multi-lounge demand grows
        private const val MAX_ACTIVE_PODS_PER_INTEREST = 8
        private const val INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
        private const val INVITE_CODE_LENGTH = 12
    }

    private data class ExistingMemberPod(
        val id: Long,
        val podIdHex: String,
        val maxMembers: Int
    )

    private data class InterestRow(
        val id: Long,
        val slug: String,
        val label: String,
        val category: String
    )

    private data class CandidatePodRow(
        val id: Long,
        val publicId: ByteArray,
        val code: String,
        val memberCount: Int,
        val maxMembers: Int
    )

    private data class MatchTxOutcome(
        val podInternalId: Long,
        val podIdHex: String,
        val newlyJoined: Boolean,
        val joinedMember: MemberDto?,
        val generalChannelHex: String?,
        val joinSystemMessage: RichMessageDto?
    )

    fun listInterests(userId: Long): List<InterestDto> {
        return jdbcClient.sql(
            """
            SELECT i.slug,
                   i.label,
                   i.category,
                   COALESCE(ps.open_pods, 0) AS open_pods,
                   COALESCE(ps.active_members, 0) AS active_members,
                   CASE WHEN ui.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_selected
            FROM interests i
            LEFT JOIN (
                SELECT interest_id,
                       SUM(CASE WHEN is_open = 1 AND allow_random_match = 1 AND member_count < max_members THEN 1 ELSE 0 END) AS open_pods,
                       SUM(member_count) AS active_members
                FROM pods
                GROUP BY interest_id
            ) ps ON ps.interest_id = i.id
            LEFT JOIN user_interests ui ON ui.interest_id = i.id AND ui.user_id = :userId
            ORDER BY i.id ASC
            """.trimIndent()
        )
            .param("userId", userId)
            .query { rs, _ ->
                InterestDto(
                    slug = rs.getString("slug"),
                    label = rs.getString("label"),
                    category = rs.getString("category"),
                    openPods = rs.getInt("open_pods"),
                    activeMembers = rs.getInt("active_members"),
                    selected = rs.getInt("is_selected") != 0
                )
            }
            .list()
    }

    fun updateUserInterests(userId: Long, rawInterests: List<String>): List<InterestDto> {
        val cleaned = rawInterests
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .take(24)

        executeWithDeadlockRetry {
            txTemplate.executeWithoutResult {
                val interestIds = LinkedHashSet<Long>()
                for (raw in cleaned) {
                    val interest = findOrCreateInterest(raw)
                    interestIds.add(interest.id)
                }

                jdbcClient.sql("DELETE FROM user_interests WHERE user_id = :userId")
                    .param("userId", userId)
                    .update()

                for (interestId in interestIds) {
                    jdbcClient.sql(
                        """
                        INSERT IGNORE INTO user_interests (user_id, interest_id, created_at)
                        VALUES (:userId, :interestId, UTC_TIMESTAMP())
                        """.trimIndent()
                    )
                        .param("userId", userId)
                        .param("interestId", interestId)
                        .update()
                }
            }
        }

        return listInterests(userId)
    }

    internal fun validateMaxMembers(maxMembers: Int?) {
        if (maxMembers != null && maxMembers !in ALLOWED_MAX_MEMBERS) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "maxMembers must be 4, 6, 10, 25, or 50")
        }
    }

    fun matchPods(principal: AuthPrincipal, req: MatchRequest): MatchResponse {
        validateMaxMembers(req.maxMembers)
        val matchedPods = mutableListOf<PodDetailDto>()

        if (req.matchAll) {
            if (!req.interest.isNullOrBlank()) {
                val explicit = findOrCreateInterest(req.interest)
                jdbcClient.sql(
                    "INSERT IGNORE INTO user_interests (user_id, interest_id, created_at) VALUES (:userId, :interestId, UTC_TIMESTAMP())"
                )
                    .param("userId", principal.userId())
                    .param("interestId", explicit.id)
                    .update()
            }

            val targetInterestIds = jdbcClient.sql(
                """
                SELECT ui.interest_id
                FROM user_interests ui
                LEFT JOIN (
                    SELECT DISTINCT p.interest_id
                    FROM pod_members pm
                    JOIN pods p ON p.id = pm.pod_id
                    WHERE pm.user_id = :userId
                ) active ON active.interest_id = ui.interest_id
                WHERE ui.user_id = :userId AND active.interest_id IS NULL
                ORDER BY ui.interest_id ASC
                """.trimIndent()
            )
                .param("userId", principal.userId())
                .query { rs, _ -> rs.getLong("interest_id") }
                .list()

            for (interestId in targetInterestIds) {
                matchedPods.add(
                    matchUserToPodByInterestId(
                        principal = principal,
                        interestId = interestId,
                        maxMembers = req.maxMembers,
                        forceNewPod = req.forceNewPod,
                        allowAdditional = req.allowAdditional
                    )
                )
            }
        } else {
            val rawInterest = req.interest?.trim()
                ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "interest is required when matchAll is false")
            if (rawInterest.isEmpty()) {
                throw ResponseStatusException(HttpStatus.BAD_REQUEST, "interest is required")
            }
            val interest = findOrCreateInterest(rawInterest)
            matchedPods.add(
                matchUserToPodByInterestId(
                    principal = principal,
                    interestId = interest.id,
                    maxMembers = req.maxMembers,
                    forceNewPod = req.forceNewPod,
                    allowAdditional = req.allowAdditional
                )
            )
        }

        val allPods = listUserPods(principal)
        return MatchResponse(matched = matchedPods, pods = allPods)
    }

    fun matchUserToPodByInterestId(
        principal: AuthPrincipal,
        interestId: Long,
        maxMembers: Int? = null,
        forceNewPod: Boolean = false,
        allowAdditional: Boolean = false
    ): PodDetailDto {
        validateMaxMembers(maxMembers)
        val outcome = executeWithDeadlockRetry(maxAttempts = 4) {
            txTemplate.execute {
                val interest = jdbcClient.sql(
                    "SELECT id, slug, label, category FROM interests WHERE id = :id LIMIT 1 FOR UPDATE"
                )
                    .param("id", interestId)
                    .query { rs, _ ->
                        InterestRow(
                            id = rs.getLong("id"),
                            slug = rs.getString("slug"),
                            label = rs.getString("label"),
                            category = rs.getString("category")
                        )
                    }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Interest not found") }

                jdbcClient.sql(
                    "INSERT IGNORE INTO user_interests (user_id, interest_id, created_at) VALUES (:userId, :interestId, UTC_TIMESTAMP())"
                )
                    .param("userId", principal.userId())
                    .param("interestId", interest.id)
                    .update()

                val existingPods = jdbcClient.sql(
                    """
                    SELECT p.id, p.public_id, p.max_members
                    FROM pod_members pm
                    JOIN pods p ON p.id = pm.pod_id
                    WHERE pm.user_id = :userId AND p.interest_id = :interestId
                    ORDER BY pm.pod_id ASC
                    """.trimIndent()
                )
                    .param("userId", principal.userId())
                    .param("interestId", interest.id)
                    .query { rs, _ ->
                        ExistingMemberPod(
                            id = rs.getLong("id"),
                            podIdHex = UuidV7.toHex(rs.getBytes("public_id")),
                            maxMembers = rs.getInt("max_members")
                        )
                    }
                    .list()

                if (!forceNewPod && !allowAdditional) {
                    if (existingPods.isNotEmpty()) {
                        val chosenExisting = if (maxMembers != null) {
                            existingPods.firstOrNull { it.maxMembers == maxMembers } ?: existingPods.first()
                        } else {
                            existingPods.first()
                        }
                        return@execute MatchTxOutcome(
                            podInternalId = chosenExisting.id,
                            podIdHex = chosenExisting.podIdHex,
                            newlyJoined = false,
                            joinedMember = null,
                            generalChannelHex = null,
                            joinSystemMessage = null
                        )
                    }
                } else if (existingPods.size >= MAX_ACTIVE_PODS_PER_INTEREST) {
                    throw ResponseStatusException(
                        HttpStatus.BAD_REQUEST,
                        "Maximum $MAX_ACTIVE_PODS_PER_INTEREST active pods per interest reached"
                    )
                }

                // Peer-blind query: NEVER inspects gender, nationality_code, full_name, or email
                val candidates = if (forceNewPod) {
                    emptyList()
                } else {
                    val maxMembersClause = if (maxMembers != null) "AND p.max_members = :maxMembers" else ""
                    val stmt = jdbcClient.sql(
                        """
                        SELECT p.id, p.public_id, p.code, p.member_count, p.max_members
                        FROM pods p
                        LEFT JOIN pod_opt_outs o ON o.user_id = :userId AND o.pod_id = p.id
                        LEFT JOIN pod_members pm_self ON pm_self.pod_id = p.id AND pm_self.user_id = :userId
                        WHERE p.interest_id = :interestId
                          AND p.is_open = 1
                          AND p.allow_random_match = 1
                          AND p.governance_mode = 'DEMOCRATIC'
                          AND p.member_count < p.max_members
                          AND o.pod_id IS NULL
                          AND pm_self.pod_id IS NULL
                          $maxMembersClause
                        LIMIT 20
                        FOR UPDATE
                        """.trimIndent()
                    )
                        .param("userId", principal.userId())
                        .param("interestId", interest.id)
                    val boundStmt = if (maxMembers != null) stmt.param("maxMembers", maxMembers) else stmt
                    boundStmt.query { rs, _ ->
                        CandidatePodRow(
                            id = rs.getLong("id"),
                            publicId = rs.getBytes("public_id"),
                            code = rs.getString("code"),
                            memberCount = rs.getInt("member_count"),
                            maxMembers = rs.getInt("max_members")
                        )
                    }.list()
                }

                val targetPodId: Long
                val targetPodPublicBytes: ByteArray
                val generalChannelId: Long
                val generalChannelHex: String

                if (candidates.isNotEmpty()) {
                    val chosen = candidates[rng.nextInt(candidates.size)]
                    targetPodId = chosen.id
                    targetPodPublicBytes = chosen.publicId

                    val generalCh = jdbcClient.sql(
                        """
                        SELECT id, public_id
                        FROM pod_channels
                        WHERE pod_id = :podId AND kind = 1
                        ORDER BY position ASC, id ASC
                        LIMIT 1
                        """.trimIndent()
                    )
                        .param("podId", targetPodId)
                        .query { rs, _ -> rs.getLong("id") to UuidV7.toHex(rs.getBytes("public_id")) }
                        .single()
                    generalChannelId = generalCh.first
                    generalChannelHex = generalCh.second
                } else {
                    targetPodPublicBytes = UuidV7.generate()
                    val code = "${interest.slug.take(18)}-${1000 + rng.nextInt(9000)}"
                    val targetMaxMembers = maxMembers ?: DEFAULT_MAX_MEMBERS
                    val podKeyHolder = GeneratedKeyHolder()
                    jdbcClient.sql(
                        """
                        INSERT INTO pods (
                            public_id, interest_id, code, title, description,
                            governance_mode, owner_user_id, is_publicized, allow_random_match,
                            member_count, max_members, is_open, created_at
                        ) VALUES (
                            :publicId, :interestId, :code, '', '',
                            'DEMOCRATIC', 0, 0, 1,
                            0, :maxMembers, 1, UTC_TIMESTAMP()
                        )
                        """.trimIndent()
                    )
                        .param("publicId", targetPodPublicBytes)
                        .param("interestId", interest.id)
                        .param("code", code)
                        .param("maxMembers", targetMaxMembers)
                        .update(podKeyHolder)
                    targetPodId = podKeyHolder.key?.toLong()
                        ?: throw IllegalStateException("Failed to generate pod ID")

                    val createdGeneral = insertDefaultPodChannels(targetPodId, interest.label, code)
                    generalChannelId = createdGeneral.first
                    generalChannelHex = createdGeneral.second
                }

                val (alias, color) = pickUniqueAliasAndColor(targetPodId, principal.userId())

                jdbcClient.sql(
                    """
                    INSERT INTO pod_members (pod_id, user_id, alias, alias_color, role, custom_status, voice_channel_id, joined_at)
                    VALUES (:podId, :userId, :alias, :color, 'MEMBER', '', 0, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("podId", targetPodId)
                    .param("userId", principal.userId())
                    .param("alias", alias)
                    .param("color", color)
                    .update()

                val updatedPodRows = jdbcClient.sql(
                    """
                    UPDATE pods
                    SET is_open = CASE WHEN member_count + 1 >= max_members THEN 0 ELSE 1 END,
                        member_count = member_count + 1
                    WHERE id = :podId AND member_count < max_members
                    """.trimIndent()
                )
                    .param("podId", targetPodId)
                    .update()

                if (updatedPodRows == 0) {
                    throw CannotAcquireLockException("Pod filled concurrently; retrying match")
                }

                val podIdHex = UuidV7.toHex(targetPodPublicBytes)
                val selfPeerId = UuidV7.peerId(targetPodPublicBytes, principal.userPublicId())
                val joinBody = "$alias joined the pod"
                val joinMsgId = insertSystemMessage(targetPodId, generalChannelId, joinBody)

                val joinMsgDto = RichMessageDto(
                    id = joinMsgId,
                    podId = podIdHex,
                    channelId = generalChannelHex,
                    senderPeerId = "system",
                    senderAlias = SYSTEM_ALIAS,
                    senderColor = SYSTEM_COLOR,
                    parentMessageId = 0L,
                    quoteMessage = null,
                    msgType = "SYSTEM",
                    body = joinBody,
                    replyCount = 0,
                    isPinned = false,
                    isBookmarked = false,
                    isDeleted = false,
                    editedAt = null,
                    createdAt = Instant.now().toString(),
                    reactions = emptyList(),
                    attachments = emptyList(),
                    poll = null
                )

                val memberDto = MemberDto(
                    peerId = selfPeerId,
                    alias = alias,
                    color = color,
                    customStatus = "",
                    online = podRealtimeHub.isPeerOnline(podIdHex, selfPeerId),
                    voiceChannelId = null,
                    isSelf = false
                )

                MatchTxOutcome(
                    podInternalId = targetPodId,
                    podIdHex = podIdHex,
                    newlyJoined = true,
                    joinedMember = memberDto,
                    generalChannelHex = generalChannelHex,
                    joinSystemMessage = joinMsgDto
                )
            }!!
        }

        if (outcome.newlyJoined && outcome.joinedMember != null && outcome.generalChannelHex != null && outcome.joinSystemMessage != null) {
            podRealtimeHub.broadcastFrame(outcome.podIdHex, WsServerFrame.MemberJoinedOut(member = outcome.joinedMember))
            podRealtimeHub.broadcastFrame(
                outcome.podIdHex,
                WsServerFrame.MessageCreatedOut(channelId = outcome.generalChannelHex, message = outcome.joinSystemMessage)
            )
            podRealtimeHub.broadcastPresenceSnapshot(outcome.podInternalId, outcome.podIdHex)
        }

        val detail = getPodDetailForUser(principal, outcome.podInternalId)
        if (outcome.newlyJoined) {
            podRealtimeHub.broadcastPodUpdated(detail)
        }
        return detail
    }

    fun listUserPods(principal: AuthPrincipal): List<PodDetailDto> {
        data class PodHeader(
            val id: Long,
            val publicIdBytes: ByteArray,
            val podIdHex: String,
            val code: String,
            val title: String,
            val description: String,
            val governanceMode: String,
            val isPublicized: Boolean,
            val allowRandomMatch: Boolean,
            val isOpen: Boolean,
            val interestSlug: String,
            val interestLabel: String,
            val myAlias: String,
            val myColor: String,
            val myRole: String,
            val myStatus: String,
            val memberCount: Int,
            val maxMembers: Int
        )

        val headers = jdbcClient.sql(
            """
            SELECT p.id,
                   p.public_id,
                   p.code,
                   p.title,
                   p.description,
                   p.governance_mode,
                   p.is_publicized,
                   p.allow_random_match,
                   p.is_open,
                   p.member_count,
                   p.max_members,
                   i.slug AS interest_slug,
                   i.label AS interest_label,
                   my_pm.alias AS my_alias,
                   my_pm.alias_color AS my_color,
                   my_pm.role AS my_role,
                   my_pm.custom_status AS my_status
            FROM pod_members my_pm
            JOIN pods p ON p.id = my_pm.pod_id
            JOIN interests i ON i.id = p.interest_id
            WHERE my_pm.user_id = :userId
            ORDER BY my_pm.joined_at ASC, p.id ASC
            """.trimIndent()
        )
            .param("userId", principal.userId())
            .query { rs, _ ->
                val pubBytes = rs.getBytes("public_id")
                PodHeader(
                    id = rs.getLong("id"),
                    publicIdBytes = pubBytes,
                    podIdHex = UuidV7.toHex(pubBytes),
                    code = rs.getString("code"),
                    title = rs.getString("title") ?: "",
                    description = rs.getString("description") ?: "",
                    governanceMode = rs.getString("governance_mode") ?: "DEMOCRATIC",
                    isPublicized = rs.getInt("is_publicized") != 0,
                    allowRandomMatch = rs.getInt("allow_random_match") != 0,
                    isOpen = rs.getInt("is_open") != 0,
                    interestSlug = rs.getString("interest_slug"),
                    interestLabel = rs.getString("interest_label"),
                    myAlias = rs.getString("my_alias"),
                    myColor = rs.getString("my_color"),
                    myRole = rs.getString("my_role") ?: "MEMBER",
                    myStatus = rs.getString("my_status") ?: "",
                    memberCount = rs.getInt("member_count"),
                    maxMembers = rs.getInt("max_members")
                )
            }
            .list()

        if (headers.isEmpty()) return emptyList()

        val podIds = headers.map { it.id }
        val podBytesById = headers.associate { it.id to it.publicIdBytes }
        val podHexById = headers.associate { it.id to it.podIdHex }

        // Batch query 1: all channels across caller's pods
        val channelIdToHex = HashMap<Long, String>()
        val channelsByPod = HashMap<Long, MutableList<ChannelDto>>()
        jdbcClient.sql(
            """
            SELECT id, public_id, pod_id, slug, label, topic, kind, position
            FROM pod_channels
            WHERE pod_id IN (:podIds)
            ORDER BY position ASC, id ASC
            """.trimIndent()
        )
            .param("podIds", podIds)
            .query { rs ->
                val chInternalId = rs.getLong("id")
                val chHex = UuidV7.toHex(rs.getBytes("public_id"))
                val podId = rs.getLong("pod_id")
                channelIdToHex[chInternalId] = chHex
                channelsByPod.computeIfAbsent(podId) { mutableListOf() }.add(
                    ChannelDto(
                        channelId = chHex,
                        slug = rs.getString("slug"),
                        label = rs.getString("label"),
                        topic = rs.getString("topic") ?: "",
                        kind = if (rs.getInt("kind") == 2) "VOICE" else "TEXT",
                        position = rs.getInt("position")
                    )
                )
            }

        // Batch query 2: all members across caller's pods (strictly peer-blind: only u.public_id read for peerId hash)
        val membersByPod = HashMap<Long, MutableList<MemberDto>>()
        jdbcClient.sql(
            """
            SELECT pm.pod_id,
                   pm.user_id,
                   u.public_id AS user_public_id,
                   pm.alias,
                   pm.alias_color,
                   pm.role,
                   pm.custom_status,
                   pm.voice_channel_id
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id IN (:podIds)
            ORDER BY pm.joined_at ASC
            """.trimIndent()
        )
            .param("podIds", podIds)
            .query { rs ->
                val podId = rs.getLong("pod_id")
                val podPubBytes = podBytesById[podId] ?: return@query
                val podHex = podHexById[podId] ?: return@query
                val memberUserId = rs.getLong("user_id")
                val peerId = UuidV7.peerId(podPubBytes, rs.getBytes("user_public_id"))
                val online = podRealtimeHub.isPeerOnline(podHex, peerId)
                val vcInternalId = rs.getLong("voice_channel_id")
                val voiceChannelHex = podRealtimeHub.getPeerVoiceChannelId(podHex, peerId)
                    ?: if (online && vcInternalId > 0L) channelIdToHex[vcInternalId] else null

                membersByPod.computeIfAbsent(podId) { mutableListOf() }.add(
                    MemberDto(
                        peerId = peerId,
                        alias = rs.getString("alias"),
                        color = rs.getString("alias_color"),
                        role = rs.getString("role") ?: "MEMBER",
                        customStatus = rs.getString("custom_status") ?: "",
                        online = online,
                        voiceChannelId = voiceChannelHex,
                        isSelf = memberUserId == principal.userId()
                    )
                )
            }

        // Batch query 3: open governance proposals count per pod (zero N+1, index-ordered GROUP BY)
        val openProposalsByPod = HashMap<Long, Int>()
        jdbcClient.sql(
            """
            SELECT pod_id, COUNT(*) AS open_cnt
            FROM pod_proposals FORCE INDEX (idx_proposals_pod_status)
            WHERE pod_id IN (:podIds)
              AND status = 'OPEN'
              AND expires_at > UTC_TIMESTAMP()
            GROUP BY pod_id
            """.trimIndent()
        )
            .param("podIds", podIds)
            .query { rs ->
                openProposalsByPod[rs.getLong("pod_id")] = rs.getInt("open_cnt")
            }

        return headers.map { h ->
            val members = membersByPod[h.id] ?: emptyList()
            PodDetailDto(
                podId = h.podIdHex,
                code = h.code,
                title = h.title,
                description = h.description,
                interestSlug = h.interestSlug,
                interestLabel = h.interestLabel,
                governanceMode = h.governanceMode,
                isPublicized = h.isPublicized,
                allowRandomMatch = h.allowRandomMatch,
                isOpen = h.isOpen,
                myPeerId = UuidV7.peerId(h.publicIdBytes, principal.userPublicId()),
                myAlias = h.myAlias,
                myColor = h.myColor,
                myRole = h.myRole,
                myStatus = h.myStatus,
                memberCount = h.memberCount,
                maxMembers = h.maxMembers,
                openProposalsCount = openProposalsByPod[h.id] ?: 0,
                channels = channelsByPod[h.id] ?: emptyList(),
                members = members
            )
        }
    }

    fun getPodDetailForUser(principal: AuthPrincipal, podInternalId: Long): PodDetailDto {
        val podHex = jdbcClient.sql("SELECT public_id FROM pods WHERE id = :id LIMIT 1")
            .param("id", podInternalId)
            .query { rs, _ -> UuidV7.toHex(rs.getBytes("public_id")) }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Pod not found") }
        return listUserPods(principal).firstOrNull { it.podId == podHex }
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Pod not found")
    }

    internal fun buildCanonicalPodDetail(podInternalId: Long): PodDetailDto? {
        data class RawPod(
            val id: Long,
            val pubBytes: ByteArray,
            val podHex: String,
            val code: String,
            val title: String,
            val description: String,
            val governanceMode: String,
            val isPublicized: Boolean,
            val allowRandomMatch: Boolean,
            val isOpen: Boolean,
            val memberCount: Int,
            val maxMembers: Int,
            val interestSlug: String,
            val interestLabel: String
        )

        val pod = jdbcClient.sql(
            """
            SELECT p.id, p.public_id, p.code, p.title, p.description,
                   p.governance_mode, p.is_publicized, p.allow_random_match, p.is_open,
                   p.member_count, p.max_members,
                   i.slug AS interest_slug, i.label AS interest_label
            FROM pods p
            JOIN interests i ON i.id = p.interest_id
            WHERE p.id = :id
            LIMIT 1
            """.trimIndent()
        )
            .param("id", podInternalId)
            .query { rs, _ ->
                val pub = rs.getBytes("public_id")
                RawPod(
                    id = rs.getLong("id"),
                    pubBytes = pub,
                    podHex = UuidV7.toHex(pub),
                    code = rs.getString("code"),
                    title = rs.getString("title") ?: "",
                    description = rs.getString("description") ?: "",
                    governanceMode = rs.getString("governance_mode") ?: "DEMOCRATIC",
                    isPublicized = rs.getInt("is_publicized") != 0,
                    allowRandomMatch = rs.getInt("allow_random_match") != 0,
                    isOpen = rs.getInt("is_open") != 0,
                    memberCount = rs.getInt("member_count"),
                    maxMembers = rs.getInt("max_members"),
                    interestSlug = rs.getString("interest_slug"),
                    interestLabel = rs.getString("interest_label")
                )
            }
            .optional()
            .orElse(null) ?: return null

        val channelIdToHex = HashMap<Long, String>()
        val channels = jdbcClient.sql(
            """
            SELECT id, public_id, slug, label, topic, kind, position
            FROM pod_channels
            WHERE pod_id = :podId
            ORDER BY position ASC, id ASC
            """.trimIndent()
        )
            .param("podId", pod.id)
            .query { rs, _ ->
                val chId = rs.getLong("id")
                val chHex = UuidV7.toHex(rs.getBytes("public_id"))
                channelIdToHex[chId] = chHex
                ChannelDto(
                    channelId = chHex,
                    slug = rs.getString("slug"),
                    label = rs.getString("label"),
                    topic = rs.getString("topic") ?: "",
                    kind = if (rs.getInt("kind") == 2) "VOICE" else "TEXT",
                    position = rs.getInt("position")
                )
            }
            .list()

        val members = jdbcClient.sql(
            """
            SELECT u.public_id AS user_public_id,
                   pm.alias,
                   pm.alias_color,
                   pm.role,
                   pm.custom_status,
                   pm.voice_channel_id
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id = :podId
            ORDER BY pm.joined_at ASC
            """.trimIndent()
        )
            .param("podId", pod.id)
            .query { rs, _ ->
                val peerId = UuidV7.peerId(pod.pubBytes, rs.getBytes("user_public_id"))
                val online = podRealtimeHub.isPeerOnline(pod.podHex, peerId)
                val vcId = rs.getLong("voice_channel_id")
                val vcHex = podRealtimeHub.getPeerVoiceChannelId(pod.podHex, peerId)
                    ?: if (online && vcId > 0L) channelIdToHex[vcId] else null
                MemberDto(
                    peerId = peerId,
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color"),
                    role = rs.getString("role") ?: "MEMBER",
                    customStatus = rs.getString("custom_status") ?: "",
                    online = online,
                    voiceChannelId = vcHex,
                    isSelf = false
                )
            }
            .list()

        val openProposals = jdbcClient.sql(
            """
            SELECT COUNT(*)
            FROM pod_proposals
            WHERE pod_id = :podId
              AND status = 'OPEN'
              AND expires_at > UTC_TIMESTAMP()
            """.trimIndent()
        )
            .param("podId", pod.id)
            .query { rs, _ -> rs.getInt(1) }
            .single()

        return PodDetailDto(
            podId = pod.podHex,
            code = pod.code,
            title = pod.title,
            description = pod.description,
            interestSlug = pod.interestSlug,
            interestLabel = pod.interestLabel,
            governanceMode = pod.governanceMode,
            isPublicized = pod.isPublicized,
            allowRandomMatch = pod.allowRandomMatch,
            isOpen = pod.isOpen,
            myPeerId = "",
            myAlias = "",
            myColor = "#232323",
            myRole = "MEMBER",
            myStatus = "",
            memberCount = pod.memberCount,
            maxMembers = pod.maxMembers,
            openProposalsCount = openProposals,
            channels = channels,
            members = members
        )
    }

    fun createChannel(principal: AuthPrincipal, podIdHexRaw: String, req: CreateChannelRequest): ChannelDto {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val rawLabel = req.label.trim()
        if (rawLabel.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Channel label is required")
        }

        val (podInternalId, podIdHex, channelDto) = executeWithDeadlockRetry {
            txTemplate.execute {
                val podRow = requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (podRow.governanceMode == "DEMOCRATIC" && podRow.memberCount > 1) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Democratic pods require a member vote to add channels — submit a proposal"
                    )
                }
                if (podRow.governanceMode == "ADMIN" && podRow.role !in setOf("OWNER", "ADMIN")) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Only pod owners and admins can add channels"
                    )
                }

                val dto = insertChannelTx(podRow.podInternalId, rawLabel, req.topic, req.kind)
                Triple(podRow.podInternalId, podRow.podIdHex, dto)
            }!!
        }

        podRealtimeHub.broadcastFrame(podIdHex, WsServerFrame.ChannelCreatedOut(channel = channelDto))
        buildCanonicalPodDetail(podInternalId)?.let { podRealtimeHub.broadcastPodUpdated(it) }
        return channelDto
    }

    internal fun insertChannelTx(
        podInternalId: Long,
        rawLabelInput: String,
        rawTopicInput: String,
        rawKindInput: String
    ): ChannelDto {
        val rawLabel = rawLabelInput.trim()
        if (rawLabel.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Channel label is required")
        }
        val kindInt = when (rawKindInput.trim().uppercase()) {
            "VOICE" -> 2
            "TEXT", "" -> 1
            else -> throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Channel kind must be TEXT or VOICE")
        }
        val baseSlug = normalizeSlug(rawLabel).take(42).ifEmpty { if (kindInt == 2) "voice-room" else "channel" }
        val cleanLabel = if (kindInt == 1) baseSlug else rawLabel.take(64)
        val cleanTopic = rawTopicInput.trim().take(160)

        val existingSlugs = jdbcClient.sql("SELECT slug FROM pod_channels WHERE pod_id = :podId")
            .param("podId", podInternalId)
            .query(String::class.java)
            .set()

        var finalSlug = baseSlug
        var suffix = 2
        while (finalSlug in existingSlugs) {
            finalSlug = "${baseSlug.take(42)}-$suffix"
            suffix++
        }

        val nextPos = jdbcClient.sql(
            "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM pod_channels WHERE pod_id = :podId"
        )
            .param("podId", podInternalId)
            .query { rs, _ -> rs.getInt("next_pos") }
            .single()
            .coerceAtMost(250)

        val chPubBytes = UuidV7.generate()
        jdbcClient.sql(
            """
            INSERT INTO pod_channels (public_id, pod_id, slug, label, topic, kind, position, created_at)
            VALUES (:publicId, :podId, :slug, :label, :topic, :kind, :position, UTC_TIMESTAMP())
            """.trimIndent()
        )
            .param("publicId", chPubBytes)
            .param("podId", podInternalId)
            .param("slug", finalSlug)
            .param("label", if (kindInt == 1) finalSlug else cleanLabel)
            .param("topic", cleanTopic)
            .param("kind", kindInt)
            .param("position", nextPos)
            .update()

        return ChannelDto(
            channelId = UuidV7.toHex(chPubBytes),
            slug = finalSlug,
            label = if (kindInt == 1) finalSlug else cleanLabel,
            topic = cleanTopic,
            kind = if (kindInt == 2) "VOICE" else "TEXT",
            position = nextPos
        )
    }

    fun deleteChannel(principal: AuthPrincipal, podIdHexRaw: String, channelIdHexRaw: String): PodDetailDto {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val chPublicBytes = parsePublicIdOrBadRequest(channelIdHexRaw, "channelId")

        val (podInternalId, podIdHex, deletedChannelHex) = executeWithDeadlockRetry {
            txTemplate.execute {
                val podRow = requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (podRow.governanceMode == "DEMOCRATIC" && podRow.memberCount > 1) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Democratic pods require a member vote — create a proposal"
                    )
                }
                if (podRow.governanceMode == "ADMIN" && podRow.role !in setOf("OWNER", "ADMIN")) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Only pod owners and admins can delete channels"
                    )
                }
                val (chHex, _) = deleteChannelTx(podRow.podInternalId, chPublicBytes)
                Triple(podRow.podInternalId, podRow.podIdHex, chHex)
            }!!
        }

        podRealtimeHub.evictVoiceChannel(podIdHex, deletedChannelHex)
        podRealtimeHub.broadcastFrame(podIdHex, WsServerFrame.ChannelDeletedOut(channelId = deletedChannelHex))
        val detail = getPodDetailForUser(principal, podInternalId)
        podRealtimeHub.broadcastPodUpdated(detail)
        return detail
    }

    internal fun deleteChannelTx(podInternalId: Long, channelPublicBytes: ByteArray): Pair<String, String> {
        data class ChRow(val id: Long, val hex: String, val slug: String, val label: String, val kind: Int)
        val ch = jdbcClient.sql(
            """
            SELECT id, public_id, slug, label, kind
            FROM pod_channels
            WHERE pod_id = :podId AND public_id = :chPub
            LIMIT 1
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .param("chPub", channelPublicBytes)
            .query { rs, _ ->
                ChRow(
                    id = rs.getLong("id"),
                    hex = UuidV7.toHex(rs.getBytes("public_id")),
                    slug = rs.getString("slug"),
                    label = rs.getString("label"),
                    kind = rs.getInt("kind")
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Channel not found") }

        if (ch.slug == "general") {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot remove #general")
        }
        if (ch.kind == 1) {
            val textCount = jdbcClient.sql(
                "SELECT COUNT(*) FROM pod_channels WHERE pod_id = :podId AND kind = 1"
            )
                .param("podId", podInternalId)
                .query { rs, _ -> rs.getInt(1) }
                .single()
            if (textCount <= 1) {
                throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot remove the last text channel")
            }
        }

        jdbcClient.sql("UPDATE pod_members SET voice_channel_id = 0 WHERE pod_id = :podId AND voice_channel_id = :chId")
            .param("podId", podInternalId)
            .param("chId", ch.id)
            .update()

        jdbcClient.sql("DELETE FROM messages WHERE pod_id = :podId AND channel_id = :chId")
            .param("podId", podInternalId)
            .param("chId", ch.id)
            .update()

        jdbcClient.sql("DELETE FROM pod_channels WHERE pod_id = :podId AND id = :chId")
            .param("podId", podInternalId)
            .param("chId", ch.id)
            .update()

        val display = if (ch.kind == 2) ch.label else "#${ch.slug}"
        return ch.hex to display
    }

    fun updateStatus(principal: AuthPrincipal, podIdHexRaw: String, customStatusRaw: String) {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val cleanStatus = customStatusRaw.trim().take(80)
        val podRow = requireMemberPodRow(principal.userId(), podPublicBytes)

        jdbcClient.sql(
            "UPDATE pod_members SET custom_status = :status WHERE pod_id = :podId AND user_id = :userId"
        )
            .param("status", cleanStatus)
            .param("podId", podRow.podInternalId)
            .param("userId", principal.userId())
            .update()

        podRealtimeHub.broadcastPresenceSnapshot(podRow.podInternalId, podRow.podIdHex)
    }

    fun leavePod(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: LeavePodRequest = LeavePodRequest()
    ): LeavePodResponse {
        validateMaxMembers(req.maxMembers)
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")

        data class LeaveTxResult(
            val podInternalId: Long,
            val podIdHex: String,
            val interestId: Long,
            val selfPeerId: String,
            val alias: String,
            val remainingMembers: Int
        )

        val left = executeWithDeadlockRetry {
            txTemplate.execute {
                val row = jdbcClient.sql(
                    """
                    SELECT p.id AS pod_id,
                           p.public_id AS pod_public_id,
                           p.interest_id,
                           p.governance_mode,
                           p.owner_user_id,
                           p.member_count,
                           pm.alias
                    FROM pods p
                    JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
                    WHERE p.public_id = :podPublicId
                    LIMIT 1
                    FOR UPDATE
                    """.trimIndent()
                )
                    .param("userId", principal.userId())
                    .param("podPublicId", podPublicBytes)
                    .query { rs, _ ->
                        val pub = rs.getBytes("pod_public_id")
                        val curCount = rs.getInt("member_count")
                        Triple(
                            LeaveTxResult(
                                podInternalId = rs.getLong("pod_id"),
                                podIdHex = UuidV7.toHex(pub),
                                interestId = rs.getLong("interest_id"),
                                selfPeerId = UuidV7.peerId(pub, principal.userPublicId()),
                                alias = rs.getString("alias"),
                                remainingMembers = (curCount - 1).coerceAtLeast(0)
                            ),
                            rs.getString("governance_mode") ?: "DEMOCRATIC",
                            rs.getLong("owner_user_id")
                        )
                    }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Pod membership not found") }

                val (leaveInfo, govMode, ownerUserId) = row
                val podInternalId = leaveInfo.podInternalId

                jdbcClient.sql("DELETE FROM pod_members WHERE pod_id = :podId AND user_id = :userId")
                    .param("podId", podInternalId)
                    .param("userId", principal.userId())
                    .update()

                if (govMode == "ADMIN" && ownerUserId == principal.userId()) {
                    val successorId = jdbcClient.sql(
                        """
                        SELECT user_id
                        FROM pod_members
                        WHERE pod_id = :podId
                        ORDER BY CASE WHEN role = 'ADMIN' THEN 0 ELSE 1 END ASC, joined_at ASC
                        LIMIT 1
                        """.trimIndent()
                    )
                        .param("podId", podInternalId)
                        .query { rs, _ -> rs.getLong("user_id") }
                        .optional()
                        .orElse(0L)

                    if (successorId > 0L) {
                        jdbcClient.sql("UPDATE pod_members SET role = 'OWNER' WHERE pod_id = :podId AND user_id = :uid")
                            .param("podId", podInternalId)
                            .param("uid", successorId)
                            .update()
                        jdbcClient.sql("UPDATE pods SET owner_user_id = :uid WHERE id = :podId")
                            .param("uid", successorId)
                            .param("podId", podInternalId)
                            .update()
                    } else {
                        jdbcClient.sql("UPDATE pods SET owner_user_id = 0, is_publicized = 0 WHERE id = :podId")
                            .param("podId", podInternalId)
                            .update()
                    }
                }

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
                    .param("userId", principal.userId())
                    .param("podId", podInternalId)
                    .update()

                leaveInfo
            }!!
        }

        podRealtimeHub.evictMember(left.podIdHex, left.selfPeerId, left.alias)
        if (left.remainingMembers > 0) {
            buildCanonicalPodDetail(left.podInternalId)?.let { podRealtimeHub.broadcastPodUpdated(it) }
        }

        val rematchedPod = if (req.rematch) {
            matchUserToPodByInterestId(
                principal = principal,
                interestId = left.interestId,
                maxMembers = req.maxMembers,
                forceNewPod = req.forceNewPod,
                allowAdditional = true
            )
        } else {
            null
        }

        return LeavePodResponse(leftPodId = left.podIdHex, newPod = rematchedPod)
    }

    fun createPodInvite(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: CreatePodInviteRequest
    ): Pair<PodInviteDto, Boolean> {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val maxUses = req.maxUses ?: 0
        if (maxUses !in 0..100) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "maxUses must be between 0 and 100")
        }
        val expiresInHours = req.expiresInHours ?: 168
        if (expiresInHours !in 0..720) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "expiresInHours must be between 0 and 720")
        }

        return executeWithDeadlockRetry {
            txTemplate.execute {
                val memberPod = requireMemberPodRow(principal.userId(), podPublicBytes)

                if (!req.regenerate) {
                    val existingCode = jdbcClient.sql(
                        """
                        SELECT pi.code
                        FROM pod_invites pi
                        WHERE pi.pod_id = :podId
                          AND pi.is_revoked = 0
                          AND pi.max_uses = :maxUses
                          AND (pi.expires_at IS NULL OR pi.expires_at > UTC_TIMESTAMP())
                          AND (pi.max_uses = 0 OR pi.uses_count < pi.max_uses)
                        ORDER BY pi.id DESC
                        LIMIT 1
                        """.trimIndent()
                    )
                        .param("podId", memberPod.podInternalId)
                        .param("maxUses", maxUses)
                        .query(String::class.java)
                        .optional()
                        .orElse(null)

                    if (existingCode != null) {
                        return@execute loadPodInviteByCodeOrThrow(existingCode) to false
                    }
                } else {
                    jdbcClient.sql(
                        "UPDATE pod_invites SET is_revoked = 1 WHERE pod_id = :podId AND is_revoked = 0"
                    )
                        .param("podId", memberPod.podInternalId)
                        .update()
                }

                var insertedCode: String? = null
                repeat(5) {
                    if (insertedCode == null) {
                        val candidate = generateInviteCode()
                        val rows = jdbcClient.sql(
                            """
                            INSERT IGNORE INTO pod_invites (
                                pod_id, code, created_by_user_id, created_by_alias,
                                max_uses, uses_count, is_revoked, expires_at, created_at
                            ) VALUES (
                                :podId, :code, :userId, :alias,
                                :maxUses, 0, 0,
                                CASE WHEN :expiresInHours = 0 THEN NULL ELSE DATE_ADD(UTC_TIMESTAMP(), INTERVAL :expiresInHours HOUR) END,
                                UTC_TIMESTAMP()
                            )
                            """.trimIndent()
                        )
                            .param("podId", memberPod.podInternalId)
                            .param("code", candidate)
                            .param("userId", principal.userId())
                            .param("alias", memberPod.alias)
                            .param("maxUses", maxUses)
                            .param("expiresInHours", expiresInHours)
                            .update()
                        if (rows == 1) {
                            insertedCode = candidate
                        }
                    }
                }

                val finalCode = insertedCode
                    ?: throw IllegalStateException("Failed to generate unique pod invite code")
                loadPodInviteByCodeOrThrow(finalCode) to true
            }!!
        }
    }

    fun listPodInvites(principal: AuthPrincipal, podIdHexRaw: String): List<PodInviteDto> {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val memberPod = requireMemberPodRow(principal.userId(), podPublicBytes)

        return jdbcClient.sql(
            """
            SELECT pi.code,
                   pi.created_by_alias,
                   pi.max_uses,
                   pi.uses_count,
                   pi.is_revoked,
                   pi.expires_at,
                   pi.created_at,
                   CASE WHEN pi.expires_at IS NOT NULL AND pi.expires_at <= UTC_TIMESTAMP() THEN 1 ELSE 0 END AS is_expired,
                   p.public_id AS pod_public_id,
                   p.code AS pod_code,
                   p.member_count,
                   p.max_members,
                   i.slug AS interest_slug,
                   i.label AS interest_label
            FROM pod_invites pi
            JOIN pods p ON p.id = pi.pod_id
            JOIN interests i ON i.id = p.interest_id
            WHERE pi.pod_id = :podId
              AND pi.is_revoked = 0
            ORDER BY pi.id DESC
            LIMIT 50
            """.trimIndent()
        )
            .param("podId", memberPod.podInternalId)
            .query { rs, _ -> mapPodInviteDto(rs) }
            .list()
    }

    fun revokePodInvite(principal: AuthPrincipal, podIdHexRaw: String, rawCode: String) {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val code = normalizeInviteCode(rawCode)
        val memberPod = requireMemberPodRow(principal.userId(), podPublicBytes)

        val exists = jdbcClient.sql(
            "SELECT 1 FROM pod_invites WHERE pod_id = :podId AND code = :code LIMIT 1"
        )
            .param("podId", memberPod.podInternalId)
            .param("code", code)
            .query(Int::class.java)
            .optional()
            .isPresent

        if (!exists) {
            throw ResponseStatusException(HttpStatus.NOT_FOUND, "Invite not found")
        }

        jdbcClient.sql(
            "UPDATE pod_invites SET is_revoked = 1 WHERE pod_id = :podId AND code = :code"
        )
            .param("podId", memberPod.podInternalId)
            .param("code", code)
            .update()
    }

    fun getPublicInvite(rawCode: String): PodInviteDto {
        val code = normalizeInviteCode(rawCode)
        return loadPodInviteByCodeOrThrow(code)
    }

    fun acceptPodInvite(principal: AuthPrincipal, rawCode: String): AcceptPodInviteResponse {
        val code = normalizeInviteCode(rawCode)

        data class LockedInviteRow(
            val id: Long,
            val podId: Long,
            val maxUses: Int,
            val usesCount: Int,
            val isRevoked: Boolean,
            val isExpired: Boolean
        )

        data class LockedPodRow(
            val id: Long,
            val publicId: ByteArray,
            val interestId: Long,
            val memberCount: Int,
            val maxMembers: Int
        )

        val outcome = executeWithDeadlockRetry(maxAttempts = 4) {
            txTemplate.execute {
                val invite = jdbcClient.sql(
                    """
                    SELECT id,
                           pod_id,
                           max_uses,
                           uses_count,
                           is_revoked,
                           CASE WHEN expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP() THEN 1 ELSE 0 END AS is_expired
                    FROM pod_invites
                    WHERE code = :code
                    LIMIT 1
                    FOR UPDATE
                    """.trimIndent()
                )
                    .param("code", code)
                    .query { rs, _ ->
                        LockedInviteRow(
                            id = rs.getLong("id"),
                            podId = rs.getLong("pod_id"),
                            maxUses = rs.getInt("max_uses"),
                            usesCount = rs.getInt("uses_count"),
                            isRevoked = rs.getInt("is_revoked") != 0,
                            isExpired = rs.getInt("is_expired") != 0
                        )
                    }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Invite not found") }

                val pod = jdbcClient.sql(
                    """
                    SELECT id, public_id, interest_id, member_count, max_members
                    FROM pods
                    WHERE id = :podId
                    LIMIT 1
                    FOR UPDATE
                    """.trimIndent()
                )
                    .param("podId", invite.podId)
                    .query { rs, _ ->
                        LockedPodRow(
                            id = rs.getLong("id"),
                            publicId = rs.getBytes("public_id"),
                            interestId = rs.getLong("interest_id"),
                            memberCount = rs.getInt("member_count"),
                            maxMembers = rs.getInt("max_members")
                        )
                    }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Pod not found") }

                val podIdHex = UuidV7.toHex(pod.publicId)

                val alreadyMember = jdbcClient.sql(
                    "SELECT 1 FROM pod_members WHERE pod_id = :podId AND user_id = :userId LIMIT 1"
                )
                    .param("podId", pod.id)
                    .param("userId", principal.userId())
                    .query(Int::class.java)
                    .optional()
                    .isPresent

                if (alreadyMember) {
                    return@execute MatchTxOutcome(
                        podInternalId = pod.id,
                        podIdHex = podIdHex,
                        newlyJoined = false,
                        joinedMember = null,
                        generalChannelHex = null,
                        joinSystemMessage = null
                    )
                }

                if (invite.isRevoked) {
                    throw ResponseStatusException(HttpStatus.GONE, "This invite link was revoked")
                }
                if (invite.isExpired) {
                    throw ResponseStatusException(HttpStatus.GONE, "This invite link has expired")
                }
                if (invite.maxUses > 0 && invite.usesCount >= invite.maxUses) {
                    throw ResponseStatusException(HttpStatus.GONE, "This invite link reached its usage limit")
                }
                if (pod.memberCount >= pod.maxMembers) {
                    throw ResponseStatusException(HttpStatus.CONFLICT, "This pod is currently full")
                }

                jdbcClient.sql(
                    "DELETE FROM pod_opt_outs WHERE user_id = :userId AND pod_id = :podId"
                )
                    .param("userId", principal.userId())
                    .param("podId", pod.id)
                    .update()

                jdbcClient.sql(
                    "INSERT IGNORE INTO user_interests (user_id, interest_id, created_at) VALUES (:userId, :interestId, UTC_TIMESTAMP())"
                )
                    .param("userId", principal.userId())
                    .param("interestId", pod.interestId)
                    .update()

                val generalCh = jdbcClient.sql(
                    """
                    SELECT id, public_id
                    FROM pod_channels
                    WHERE pod_id = :podId AND kind = 1
                    ORDER BY position ASC, id ASC
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("podId", pod.id)
                    .query { rs, _ -> rs.getLong("id") to UuidV7.toHex(rs.getBytes("public_id")) }
                    .single()
                val generalChannelId = generalCh.first
                val generalChannelHex = generalCh.second

                val (alias, color) = pickUniqueAliasAndColor(pod.id, principal.userId())

                jdbcClient.sql(
                    """
                    INSERT INTO pod_members (pod_id, user_id, alias, alias_color, custom_status, voice_channel_id, joined_at)
                    VALUES (:podId, :userId, :alias, :color, '', 0, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("podId", pod.id)
                    .param("userId", principal.userId())
                    .param("alias", alias)
                    .param("color", color)
                    .update()

                val updatedPodRows = jdbcClient.sql(
                    """
                    UPDATE pods
                    SET is_open = CASE WHEN member_count + 1 >= max_members THEN 0 ELSE 1 END,
                        member_count = member_count + 1
                    WHERE id = :podId AND member_count < max_members
                    """.trimIndent()
                )
                    .param("podId", pod.id)
                    .update()

                if (updatedPodRows == 0) {
                    throw ResponseStatusException(HttpStatus.CONFLICT, "This pod is currently full")
                }

                jdbcClient.sql(
                    "UPDATE pod_invites SET uses_count = uses_count + 1 WHERE id = :inviteId"
                )
                    .param("inviteId", invite.id)
                    .update()

                val selfPeerId = UuidV7.peerId(pod.publicId, principal.userPublicId())
                val joinBody = "$alias joined via invite link"
                val joinMsgId = insertSystemMessage(pod.id, generalChannelId, joinBody)

                val joinMsgDto = RichMessageDto(
                    id = joinMsgId,
                    podId = podIdHex,
                    channelId = generalChannelHex,
                    senderPeerId = "system",
                    senderAlias = SYSTEM_ALIAS,
                    senderColor = SYSTEM_COLOR,
                    parentMessageId = 0L,
                    quoteMessage = null,
                    msgType = "SYSTEM",
                    body = joinBody,
                    replyCount = 0,
                    isPinned = false,
                    isBookmarked = false,
                    isDeleted = false,
                    editedAt = null,
                    createdAt = Instant.now().toString(),
                    reactions = emptyList(),
                    attachments = emptyList(),
                    poll = null
                )

                val memberDto = MemberDto(
                    peerId = selfPeerId,
                    alias = alias,
                    color = color,
                    customStatus = "",
                    online = podRealtimeHub.isPeerOnline(podIdHex, selfPeerId),
                    voiceChannelId = null,
                    isSelf = false
                )

                MatchTxOutcome(
                    podInternalId = pod.id,
                    podIdHex = podIdHex,
                    newlyJoined = true,
                    joinedMember = memberDto,
                    generalChannelHex = generalChannelHex,
                    joinSystemMessage = joinMsgDto
                )
            }!!
        }

        if (outcome.newlyJoined && outcome.joinedMember != null && outcome.generalChannelHex != null && outcome.joinSystemMessage != null) {
            podRealtimeHub.broadcastFrame(outcome.podIdHex, WsServerFrame.MemberJoinedOut(member = outcome.joinedMember))
            podRealtimeHub.broadcastFrame(
                outcome.podIdHex,
                WsServerFrame.MessageCreatedOut(channelId = outcome.generalChannelHex, message = outcome.joinSystemMessage)
            )
            podRealtimeHub.broadcastPresenceSnapshot(outcome.podInternalId, outcome.podIdHex)
        }

        val allPods = listUserPods(principal)
        val joinedPod = allPods.firstOrNull { it.podId == outcome.podIdHex }
            ?: getPodDetailForUser(principal, outcome.podInternalId)

        if (outcome.newlyJoined) {
            podRealtimeHub.broadcastPodUpdated(joinedPod)
        }

        return AcceptPodInviteResponse(
            alreadyMember = !outcome.newlyJoined,
            pod = joinedPod,
            pods = allPods
        )
    }

    fun createCustomPod(principal: AuthPrincipal, req: CreateCustomPodRequest): CustomPodResponse {
        val planTier = jdbcClient.sql("SELECT plan_tier FROM users WHERE id = :id LIMIT 1")
            .param("id", principal.userId())
            .query { rs, _ -> rs.getString("plan_tier") ?: "FREE" }
            .optional()
            .orElse("FREE")

        if (planTier != "PREMIUM") {
            throw ResponseStatusException(
                HttpStatus.FORBIDDEN,
                "Upgrade to Canopy Pro to create custom admin groups"
            )
        }

        val cleanTitle = req.title.trim()
        if (cleanTitle.isEmpty() || cleanTitle.length > 80) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Title must be 1 to 80 characters")
        }
        val rawInterest = req.interest.trim()
        if (rawInterest.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Interest is required")
        }
        val cleanDesc = (req.description ?: "").trim()
        if (cleanDesc.length > 280) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Description must not exceed 280 characters")
        }
        val targetMax = req.maxMembers ?: DEFAULT_MAX_MEMBERS
        validateMaxMembers(targetMax)

        val podInternalId = executeWithDeadlockRetry {
            txTemplate.execute {
                val interest = findOrCreateInterest(rawInterest)
                jdbcClient.sql(
                    "INSERT IGNORE INTO user_interests (user_id, interest_id, created_at) VALUES (:userId, :interestId, UTC_TIMESTAMP())"
                )
                    .param("userId", principal.userId())
                    .param("interestId", interest.id)
                    .update()

                val baseCode = (if (!req.code.isNullOrBlank()) normalizeSlug(req.code) else normalizeSlug(cleanTitle))
                    .take(26)
                    .ifEmpty { interest.slug.take(18) }

                val codeExists = jdbcClient.sql("SELECT 1 FROM pods WHERE code = :code LIMIT 1")
                    .param("code", baseCode)
                    .query(Int::class.java)
                    .optional()
                    .isPresent
                val finalCode = if (!codeExists) baseCode else "$baseCode-${100 + rng.nextInt(900)}"

                val podPubBytes = UuidV7.generate()
                val kh = GeneratedKeyHolder()
                jdbcClient.sql(
                    """
                    INSERT INTO pods (
                        public_id, interest_id, code, title, description,
                        governance_mode, owner_user_id, is_publicized, allow_random_match,
                        member_count, max_members, is_open, created_at
                    ) VALUES (
                        :publicId, :interestId, :code, :title, :description,
                        'ADMIN', :ownerUserId, :isPublicized, 0,
                        1, :maxMembers, 1, UTC_TIMESTAMP()
                    )
                    """.trimIndent()
                )
                    .param("publicId", podPubBytes)
                    .param("interestId", interest.id)
                    .param("code", finalCode)
                    .param("title", cleanTitle)
                    .param("description", cleanDesc)
                    .param("ownerUserId", principal.userId())
                    .param("isPublicized", if (req.isPublicized) 1 else 0)
                    .param("maxMembers", targetMax)
                    .update(kh)

                val createdPodId = kh.key?.toLong()
                    ?: throw IllegalStateException("Failed to generate custom pod ID")

                val (alias, color) = pickUniqueAliasAndColor(createdPodId, principal.userId())
                jdbcClient.sql(
                    """
                    INSERT INTO pod_members (pod_id, user_id, alias, alias_color, role, custom_status, voice_channel_id, joined_at)
                    VALUES (:podId, :userId, :alias, :color, 'OWNER', '', 0, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("podId", createdPodId)
                    .param("userId", principal.userId())
                    .param("alias", alias)
                    .param("color", color)
                    .update()

                insertDefaultPodChannels(createdPodId, cleanTitle, finalCode)
                createdPodId
            }!!
        }

        val allPods = listUserPods(principal)
        val createdPod = getPodDetailForUser(principal, podInternalId)
        return CustomPodResponse(pod = createdPod, pods = allPods)
    }

    fun listPublicizedPods(callerUserId: Long, rawInterest: String?): List<PublicizedPodDto> {
        val cleanInterest = rawInterest?.trim()?.takeIf { it.isNotEmpty() }
        val interestIdFilter: Long? = if (cleanInterest != null) {
            val slug = normalizeSlug(cleanInterest)
            if (slug.isEmpty()) return emptyList()
            val found = jdbcClient.sql("SELECT id FROM interests WHERE slug = :slug LIMIT 1")
                .param("slug", slug)
                .query { rs, _ -> rs.getLong("id") }
                .optional()
                .orElse(null)
            found ?: return emptyList()
        } else {
            null
        }

        val whereClause = if (interestIdFilter != null) {
            "WHERE p.is_publicized = 1 AND p.interest_id = :interestId"
        } else {
            "WHERE p.is_publicized = 1"
        }

        val orderClause = if (interestIdFilter != null) {
            "ORDER BY p.member_count DESC, p.id ASC"
        } else {
            "ORDER BY p.interest_id DESC, p.member_count DESC, p.id ASC"
        }

        val stmt = jdbcClient.sql(
            """
            SELECT p.public_id,
                   p.code,
                   p.title,
                   p.description,
                   p.member_count,
                   p.max_members,
                   i.slug AS interest_slug,
                   i.label AS interest_label,
                   COALESCE(owner_pm.alias, 'Founder') AS founder_alias,
                   CASE WHEN self_pm.user_id IS NOT NULL THEN 1 ELSE 0 END AS already_member
            FROM pods p FORCE INDEX (idx_pods_publicized)
            JOIN interests i ON i.id = p.interest_id
            LEFT JOIN pod_members owner_pm ON owner_pm.pod_id = p.id AND owner_pm.user_id = p.owner_user_id
            LEFT JOIN pod_members self_pm ON self_pm.pod_id = p.id AND self_pm.user_id = :callerUserId
            $whereClause
            $orderClause
            LIMIT 50
            """.trimIndent()
        ).param("callerUserId", callerUserId)

        val bound = if (interestIdFilter != null) stmt.param("interestId", interestIdFilter) else stmt
        return bound.query { rs, _ ->
            val rawTitle = rs.getString("title") ?: ""
            val code = rs.getString("code")
            PublicizedPodDto(
                podId = UuidV7.toHex(rs.getBytes("public_id")),
                code = code,
                title = rawTitle.ifBlank { code },
                description = rs.getString("description") ?: "",
                interestSlug = rs.getString("interest_slug"),
                interestLabel = rs.getString("interest_label"),
                founderAlias = rs.getString("founder_alias"),
                memberCount = rs.getInt("member_count"),
                maxMembers = rs.getInt("max_members"),
                alreadyMember = rs.getInt("already_member") != 0
            )
        }.list()
    }

    fun joinPublicizedPod(principal: AuthPrincipal, podIdHexRaw: String): CustomPodResponse {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")

        data class LockedPubPod(
            val id: Long,
            val publicId: ByteArray,
            val interestId: Long,
            val isPublicized: Boolean,
            val isOpen: Boolean,
            val memberCount: Int,
            val maxMembers: Int
        )

        val outcome = executeWithDeadlockRetry(maxAttempts = 4) {
            txTemplate.execute {
                val pod = jdbcClient.sql(
                    """
                    SELECT id, public_id, interest_id, is_publicized, is_open, member_count, max_members
                    FROM pods
                    WHERE public_id = :podPub
                    LIMIT 1
                    FOR UPDATE
                    """.trimIndent()
                )
                    .param("podPub", podPublicBytes)
                    .query { rs, _ ->
                        LockedPubPod(
                            id = rs.getLong("id"),
                            publicId = rs.getBytes("public_id"),
                            interestId = rs.getLong("interest_id"),
                            isPublicized = rs.getInt("is_publicized") != 0,
                            isOpen = rs.getInt("is_open") != 0,
                            memberCount = rs.getInt("member_count"),
                            maxMembers = rs.getInt("max_members")
                        )
                    }
                    .optional()
                    .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Group not found") }

                val podIdHex = UuidV7.toHex(pod.publicId)

                val alreadyMember = jdbcClient.sql(
                    "SELECT 1 FROM pod_members WHERE pod_id = :podId AND user_id = :userId LIMIT 1"
                )
                    .param("podId", pod.id)
                    .param("userId", principal.userId())
                    .query(Int::class.java)
                    .optional()
                    .isPresent

                if (alreadyMember) {
                    return@execute MatchTxOutcome(
                        podInternalId = pod.id,
                        podIdHex = podIdHex,
                        newlyJoined = false,
                        joinedMember = null,
                        generalChannelHex = null,
                        joinSystemMessage = null
                    )
                }

                if (!pod.isPublicized) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "This group is private — an invite link is required to join"
                    )
                }

                val optedOutOrKicked = jdbcClient.sql(
                    "SELECT 1 FROM pod_opt_outs WHERE user_id = :userId AND pod_id = :podId LIMIT 1"
                )
                    .param("userId", principal.userId())
                    .param("podId", pod.id)
                    .query(Int::class.java)
                    .optional()
                    .isPresent

                if (optedOutOrKicked) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "You cannot rejoin this group without a direct invite"
                    )
                }

                if (pod.memberCount >= pod.maxMembers) {
                    throw ResponseStatusException(HttpStatus.CONFLICT, "This group is currently full")
                }
                if (!pod.isOpen) {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "This group is currently locked")
                }

                jdbcClient.sql(
                    "INSERT IGNORE INTO user_interests (user_id, interest_id, created_at) VALUES (:userId, :interestId, UTC_TIMESTAMP())"
                )
                    .param("userId", principal.userId())
                    .param("interestId", pod.interestId)
                    .update()

                val (alias, color) = pickUniqueAliasAndColor(pod.id, principal.userId())
                jdbcClient.sql(
                    """
                    INSERT INTO pod_members (pod_id, user_id, alias, alias_color, role, custom_status, voice_channel_id, joined_at)
                    VALUES (:podId, :userId, :alias, :color, 'MEMBER', '', 0, UTC_TIMESTAMP())
                    """.trimIndent()
                )
                    .param("podId", pod.id)
                    .param("userId", principal.userId())
                    .param("alias", alias)
                    .param("color", color)
                    .update()

                val updatedRows = jdbcClient.sql(
                    """
                    UPDATE pods
                    SET is_open = CASE WHEN member_count + 1 >= max_members THEN 0 ELSE 1 END,
                        member_count = member_count + 1
                    WHERE id = :podId AND member_count < max_members
                    """.trimIndent()
                )
                    .param("podId", pod.id)
                    .update()
                if (updatedRows == 0) {
                    throw ResponseStatusException(HttpStatus.CONFLICT, "This group is currently full")
                }

                val selfPeerId = UuidV7.peerId(pod.publicId, principal.userPublicId())
                val (generalChHex, joinMsgDto) = insertSystemMessageAndBuildDto(
                    pod.id,
                    podIdHex,
                    "$alias joined the group"
                )

                val memberDto = MemberDto(
                    peerId = selfPeerId,
                    alias = alias,
                    color = color,
                    role = "MEMBER",
                    customStatus = "",
                    online = podRealtimeHub.isPeerOnline(podIdHex, selfPeerId),
                    voiceChannelId = null,
                    isSelf = false
                )

                MatchTxOutcome(
                    podInternalId = pod.id,
                    podIdHex = podIdHex,
                    newlyJoined = true,
                    joinedMember = memberDto,
                    generalChannelHex = generalChHex,
                    joinSystemMessage = joinMsgDto
                )
            }!!
        }

        if (outcome.newlyJoined && outcome.joinedMember != null && outcome.generalChannelHex != null && outcome.joinSystemMessage != null) {
            podRealtimeHub.broadcastFrame(outcome.podIdHex, WsServerFrame.MemberJoinedOut(member = outcome.joinedMember))
            podRealtimeHub.broadcastFrame(
                outcome.podIdHex,
                WsServerFrame.MessageCreatedOut(channelId = outcome.generalChannelHex, message = outcome.joinSystemMessage)
            )
            podRealtimeHub.broadcastPresenceSnapshot(outcome.podInternalId, outcome.podIdHex)
        }

        val allPods = listUserPods(principal)
        val joinedPod = allPods.firstOrNull { it.podId == outcome.podIdHex }
            ?: getPodDetailForUser(principal, outcome.podInternalId)

        if (outcome.newlyJoined) {
            podRealtimeHub.broadcastPodUpdated(joinedPod)
        }

        return CustomPodResponse(pod = joinedPod, pods = allPods)
    }

    fun updatePodSettings(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: UpdatePodSettingsRequest
    ): PodDetailDto {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        if (req.maxMembers != null) {
            validateMaxMembers(req.maxMembers)
        }

        val podInternalId = executeWithDeadlockRetry {
            txTemplate.execute {
                val pod = requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (pod.governanceMode == "DEMOCRATIC") {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Democratic pods require a member vote — create a proposal"
                    )
                }
                if (pod.role !in setOf("OWNER", "ADMIN")) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Only pod owners and admins can update settings"
                    )
                }

                val current = jdbcClient.sql(
                    """
                    SELECT title, description, max_members, is_publicized, is_open, member_count
                    FROM pods
                    WHERE id = :id
                    LIMIT 1
                    """.trimIndent()
                )
                    .param("id", pod.podInternalId)
                    .query { rs, _ ->
                        listOf(
                            rs.getString("title") ?: "",
                            rs.getString("description") ?: "",
                            rs.getInt("max_members"),
                            rs.getInt("is_publicized") != 0,
                            rs.getInt("is_open") != 0,
                            rs.getInt("member_count")
                        )
                    }
                    .single()

                val curTitle = current[0] as String
                val curDesc = current[1] as String
                val curMax = current[2] as Int
                val curPub = current[3] as Boolean
                val curOpen = current[4] as Boolean
                val curMemberCount = current[5] as Int

                val nextTitle = if (req.title != null) {
                    val t = req.title.trim()
                    if (t.isEmpty() || t.length > 80) {
                        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Title must be 1 to 80 characters")
                    }
                    t
                } else {
                    curTitle
                }

                val nextDesc = if (req.description != null) {
                    val d = req.description.trim()
                    if (d.length > 280) {
                        throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Description must not exceed 280 characters")
                    }
                    d
                } else {
                    curDesc
                }

                val nextMax = req.maxMembers ?: curMax
                val nextPub = req.isPublicized ?: curPub
                val requestedOpen = req.isOpen ?: curOpen
                val nextOpen = requestedOpen && curMemberCount < nextMax

                jdbcClient.sql(
                    """
                    UPDATE pods
                    SET title = :title,
                        description = :description,
                        max_members = :maxMembers,
                        is_publicized = :isPublicized,
                        is_open = :isOpen
                    WHERE id = :id
                    """.trimIndent()
                )
                    .param("title", nextTitle)
                    .param("description", nextDesc)
                    .param("maxMembers", nextMax)
                    .param("isPublicized", if (nextPub) 1 else 0)
                    .param("isOpen", if (nextOpen) 1 else 0)
                    .param("id", pod.podInternalId)
                    .update()

                pod.podInternalId
            }!!
        }

        val detail = getPodDetailForUser(principal, podInternalId)
        podRealtimeHub.broadcastPodUpdated(detail)
        return detail
    }

    fun adminKickMember(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: AdminKickRequest
    ): PodDetailDto {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val targetPeerId = req.targetPeerId.trim()
        if (targetPeerId.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "targetPeerId is required")
        }

        data class KickOutcome(
            val podInternalId: Long,
            val podIdHex: String,
            val kickedPeerId: String,
            val kickedAlias: String,
            val generalChHex: String,
            val sysMsg: RichMessageDto
        )

        val out = executeWithDeadlockRetry {
            txTemplate.execute {
                val pod = requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (pod.governanceMode != "ADMIN") {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Democratic pods require a member vote — create a proposal"
                    )
                }
                if (pod.role !in setOf("OWNER", "ADMIN")) {
                    throw ResponseStatusException(
                        HttpStatus.FORBIDDEN,
                        "Only pod owners and admins can remove members"
                    )
                }

                val target = findPodMemberByPeerId(pod.podInternalId, podPublicBytes, targetPeerId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Target member not found")

                if (target.userId == principal.userId()) {
                    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot kick yourself")
                }
                if (target.role == "OWNER") {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot kick the group owner")
                }
                if (pod.role == "ADMIN" && target.role == "ADMIN") {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Admins cannot kick other admins")
                }

                jdbcClient.sql("DELETE FROM pod_members WHERE pod_id = :podId AND user_id = :targetUid")
                    .param("podId", pod.podInternalId)
                    .param("targetUid", target.userId)
                    .update()

                jdbcClient.sql(
                    """
                    UPDATE pods
                    SET is_open = CASE WHEN member_count > 1 AND (member_count - 1) < max_members THEN 1 ELSE 0 END,
                        member_count = CASE WHEN member_count > 0 THEN member_count - 1 ELSE 0 END
                    WHERE id = :podId
                    """.trimIndent()
                )
                    .param("podId", pod.podInternalId)
                    .update()

                jdbcClient.sql(
                    """
                    INSERT INTO pod_opt_outs (user_id, pod_id, left_at)
                    VALUES (:userId, :podId, UTC_TIMESTAMP())
                    ON DUPLICATE KEY UPDATE left_at = UTC_TIMESTAMP()
                    """.trimIndent()
                )
                    .param("userId", target.userId)
                    .param("podId", pod.podInternalId)
                    .update()

                val (chHex, sysMsg) = insertSystemMessageAndBuildDto(
                    pod.podInternalId,
                    pod.podIdHex,
                    "${target.alias} was removed by ${pod.alias}"
                )

                KickOutcome(
                    podInternalId = pod.podInternalId,
                    podIdHex = pod.podIdHex,
                    kickedPeerId = target.peerId,
                    kickedAlias = target.alias,
                    generalChHex = chHex,
                    sysMsg = sysMsg
                )
            }!!
        }

        podRealtimeHub.broadcastFrame(
            out.podIdHex,
            WsServerFrame.MemberKickedOut(peerId = out.kickedPeerId, alias = out.kickedAlias)
        )
        podRealtimeHub.evictMember(out.podIdHex, out.kickedPeerId, out.kickedAlias)
        podRealtimeHub.broadcastFrame(
            out.podIdHex,
            WsServerFrame.MessageCreatedOut(channelId = out.generalChHex, message = out.sysMsg)
        )

        val detail = getPodDetailForUser(principal, out.podInternalId)
        podRealtimeHub.broadcastPodUpdated(detail)
        return detail
    }

    fun adminUpdateRole(
        principal: AuthPrincipal,
        podIdHexRaw: String,
        req: AdminRoleRequest
    ): PodDetailDto {
        val podPublicBytes = parsePublicIdOrBadRequest(podIdHexRaw, "podId")
        val targetPeerId = req.targetPeerId.trim()
        val newRole = req.role.trim().uppercase()
        if (targetPeerId.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "targetPeerId is required")
        }
        if (newRole !in setOf("ADMIN", "MEMBER")) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Role must be ADMIN or MEMBER")
        }

        val (podInternalId, podIdHex, sysPair) = executeWithDeadlockRetry {
            txTemplate.execute {
                val pod = requireLockedMemberPodRow(principal.userId(), podPublicBytes)
                if (pod.governanceMode != "ADMIN") {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Roles only apply to admin groups")
                }
                if (pod.role != "OWNER") {
                    throw ResponseStatusException(HttpStatus.FORBIDDEN, "Only the group owner can change member roles")
                }

                val target = findPodMemberByPeerId(pod.podInternalId, podPublicBytes, targetPeerId)
                    ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Target member not found")

                if (target.userId == principal.userId() || target.role == "OWNER") {
                    throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot change the owner's role")
                }

                jdbcClient.sql("UPDATE pod_members SET role = :role WHERE pod_id = :podId AND user_id = :uid")
                    .param("role", newRole)
                    .param("podId", pod.podInternalId)
                    .param("uid", target.userId)
                    .update()

                val label = if (newRole == "ADMIN") "promoted to Admin" else "set to Member"
                val sys = insertSystemMessageAndBuildDto(
                    pod.podInternalId,
                    pod.podIdHex,
                    "${target.alias} was $label by ${pod.alias}"
                )
                Triple(pod.podInternalId, pod.podIdHex, sys)
            }!!
        }

        podRealtimeHub.broadcastFrame(
            podIdHex,
            WsServerFrame.MessageCreatedOut(channelId = sysPair.first, message = sysPair.second)
        )
        podRealtimeHub.broadcastPresenceSnapshot(podInternalId, podIdHex)
        val detail = getPodDetailForUser(principal, podInternalId)
        podRealtimeHub.broadcastPodUpdated(detail)
        return detail
    }

    internal data class ResolvedPodMember(
        val userId: Long,
        val peerId: String,
        val alias: String,
        val role: String
    )

    internal fun findPodMemberByPeerId(
        podInternalId: Long,
        podPublicBytes: ByteArray,
        targetPeerId: String
    ): ResolvedPodMember? {
        return jdbcClient.sql(
            """
            SELECT pm.user_id, u.public_id AS user_public_id, pm.alias, pm.role
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id = :podId
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ ->
                ResolvedPodMember(
                    userId = rs.getLong("user_id"),
                    peerId = UuidV7.peerId(podPublicBytes, rs.getBytes("user_public_id")),
                    alias = rs.getString("alias"),
                    role = rs.getString("role") ?: "MEMBER"
                )
            }
            .list()
            .firstOrNull { it.peerId == targetPeerId }
    }

    internal fun insertSystemMessageAndBuildDto(
        podInternalId: Long,
        podIdHex: String,
        body: String
    ): Pair<String, RichMessageDto> {
        val generalCh = jdbcClient.sql(
            """
            SELECT id, public_id
            FROM pod_channels
            WHERE pod_id = :podId AND kind = 1
            ORDER BY CASE WHEN slug = 'general' THEN 0 ELSE 1 END ASC, position ASC, id ASC
            LIMIT 1
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ -> rs.getLong("id") to UuidV7.toHex(rs.getBytes("public_id")) }
            .single()

        val msgId = insertSystemMessage(podInternalId, generalCh.first, body)
        val dto = RichMessageDto(
            id = msgId,
            podId = podIdHex,
            channelId = generalCh.second,
            senderPeerId = "system",
            senderAlias = SYSTEM_ALIAS,
            senderColor = SYSTEM_COLOR,
            parentMessageId = 0L,
            quoteMessage = null,
            msgType = "SYSTEM",
            body = body,
            replyCount = 0,
            isPinned = false,
            isBookmarked = false,
            isDeleted = false,
            editedAt = null,
            createdAt = Instant.now().toString(),
            reactions = emptyList(),
            attachments = emptyList(),
            poll = null,
            proposal = null
        )
        return generalCh.second to dto
    }

    private fun generateInviteCode(): String {
        val sb = StringBuilder(INVITE_CODE_LENGTH)
        repeat(INVITE_CODE_LENGTH) {
            sb.append(INVITE_ALPHABET[rng.nextInt(INVITE_ALPHABET.length)])
        }
        return sb.toString()
    }

    private fun loadPodInviteByCodeOrThrow(code: String): PodInviteDto {
        return jdbcClient.sql(
            """
            SELECT pi.code,
                   pi.created_by_alias,
                   pi.max_uses,
                   pi.uses_count,
                   pi.is_revoked,
                   pi.expires_at,
                   pi.created_at,
                   CASE WHEN pi.expires_at IS NOT NULL AND pi.expires_at <= UTC_TIMESTAMP() THEN 1 ELSE 0 END AS is_expired,
                   p.public_id AS pod_public_id,
                   p.code AS pod_code,
                   p.member_count,
                   p.max_members,
                   i.slug AS interest_slug,
                   i.label AS interest_label
            FROM pod_invites pi
            JOIN pods p ON p.id = pi.pod_id
            JOIN interests i ON i.id = p.interest_id
            WHERE pi.code = :code
            LIMIT 1
            """.trimIndent()
        )
            .param("code", code)
            .query { rs, _ -> mapPodInviteDto(rs) }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.NOT_FOUND, "Invite not found") }
    }

    private fun mapPodInviteDto(rs: java.sql.ResultSet): PodInviteDto {
        val memberCount = rs.getInt("member_count")
        val maxMembers = rs.getInt("max_members")
        val maxUses = rs.getInt("max_uses")
        val usesCount = rs.getInt("uses_count")
        val isRevoked = rs.getInt("is_revoked") != 0
        val isExpired = rs.getInt("is_expired") != 0
        val isFull = memberCount >= maxMembers
        val canAccept = !isRevoked && !isExpired && !isFull && (maxUses == 0 || usesCount < maxUses)
        val expiresLdt = rs.getObject("expires_at", LocalDateTime::class.java)
        val createdLdt = rs.getObject("created_at", LocalDateTime::class.java)
        return PodInviteDto(
            code = rs.getString("code"),
            podId = UuidV7.toHex(rs.getBytes("pod_public_id")),
            podCode = rs.getString("pod_code"),
            interestSlug = rs.getString("interest_slug"),
            interestLabel = rs.getString("interest_label"),
            invitedByAlias = rs.getString("created_by_alias"),
            memberCount = memberCount,
            maxMembers = maxMembers,
            maxUses = maxUses,
            usesCount = usesCount,
            expiresAt = expiresLdt?.toInstant(ZoneOffset.UTC)?.toString(),
            createdAt = (createdLdt ?: LocalDateTime.now(ZoneOffset.UTC)).toInstant(ZoneOffset.UTC).toString(),
            isExpired = isExpired,
            isRevoked = isRevoked,
            isFull = isFull,
            canAccept = canAccept
        )
    }

    internal data class LockedMemberPodLookup(
        val podInternalId: Long,
        val podPublicBytes: ByteArray,
        val podIdHex: String,
        val governanceMode: String,
        val memberCount: Int,
        val maxMembers: Int,
        val alias: String,
        val color: String,
        val role: String
    )

    internal fun requireLockedMemberPodRow(userId: Long, podPublicBytes: ByteArray): LockedMemberPodLookup {
        return jdbcClient.sql(
            """
            SELECT p.id AS pod_id,
                   p.public_id AS pod_public_id,
                   p.governance_mode,
                   p.member_count,
                   p.max_members,
                   pm.alias,
                   pm.alias_color,
                   pm.role
            FROM pods p
            JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPublicId
            LIMIT 1
            FOR UPDATE
            """.trimIndent()
        )
            .param("userId", userId)
            .param("podPublicId", podPublicBytes)
            .query { rs, _ ->
                val pub = rs.getBytes("pod_public_id")
                LockedMemberPodLookup(
                    podInternalId = rs.getLong("pod_id"),
                    podPublicBytes = pub,
                    podIdHex = UuidV7.toHex(pub),
                    governanceMode = rs.getString("governance_mode") ?: "DEMOCRATIC",
                    memberCount = rs.getInt("member_count"),
                    maxMembers = rs.getInt("max_members"),
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color"),
                    role = rs.getString("role") ?: "MEMBER"
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod") }
    }

    private data class MemberPodLookup(
        val podInternalId: Long,
        val podIdHex: String,
        val alias: String,
        val color: String
    )

    private fun requireMemberPodRow(userId: Long, podPublicBytes: ByteArray): MemberPodLookup {
        return jdbcClient.sql(
            """
            SELECT p.id AS pod_id,
                   p.public_id AS pod_public_id,
                   pm.alias,
                   pm.alias_color
            FROM pods p
            JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = :userId
            WHERE p.public_id = :podPublicId
            LIMIT 1
            """.trimIndent()
        )
            .param("userId", userId)
            .param("podPublicId", podPublicBytes)
            .query { rs, _ ->
                MemberPodLookup(
                    podInternalId = rs.getLong("pod_id"),
                    podIdHex = UuidV7.toHex(rs.getBytes("pod_public_id")),
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color")
                )
            }
            .optional()
            .orElseThrow { ResponseStatusException(HttpStatus.FORBIDDEN, "Not a member of this pod") }
    }

    private fun insertDefaultPodChannels(podId: Long, interestLabel: String, podCode: String): Pair<Long, String> {
        data class DefaultCh(val slug: String, val label: String, val topic: String, val kind: Int, val pos: Int)

        val defaults = listOf(
            DefaultCh("general", "general", "Main lounge & introductions", 1, 0),
            DefaultCh("links-and-clips", "links-and-clips", "Share links, builds, and media", 1, 1),
            DefaultCh("off-topic", "off-topic", "Random side tangents", 1, 2),
            DefaultCh("lounge-voice", "Lounge Voice", "Always-open group audio call", 2, 3),
            DefaultCh("coop-voice", "Co-op & Focus", "Secondary voice huddle", 2, 4)
        )

        var generalInternalId = 0L
        var generalHex = ""

        for (ch in defaults) {
            val chPub = UuidV7.generate()
            val kh = GeneratedKeyHolder()
            jdbcClient.sql(
                """
                INSERT INTO pod_channels (public_id, pod_id, slug, label, topic, kind, position, created_at)
                VALUES (:publicId, :podId, :slug, :label, :topic, :kind, :position, UTC_TIMESTAMP())
                """.trimIndent()
            )
                .param("publicId", chPub)
                .param("podId", podId)
                .param("slug", ch.slug)
                .param("label", ch.label)
                .param("topic", ch.topic)
                .param("kind", ch.kind)
                .param("position", ch.pos)
                .update(kh)

            if (ch.slug == "general") {
                generalInternalId = kh.key!!.toLong()
                generalHex = UuidV7.toHex(chPub)
            }
        }

        val welcomeBody =
            "Welcome to **$interestLabel** (`$podCode`) — peer-blind room where only aliases exist. Say hi or run `/icebreaker` and `/poll`!"
        insertSystemMessage(podId, generalInternalId, welcomeBody)
        return generalInternalId to generalHex
    }

    private fun insertSystemMessage(podId: Long, channelId: Long, body: String): Long {
        val kh = GeneratedKeyHolder()
        jdbcClient.sql(
            """
            INSERT INTO messages (
                pod_id, channel_id, sender_user_id, sender_alias, sender_color,
                parent_message_id, quote_message_id, msg_type, body, created_at
            ) VALUES (
                :podId, :channelId, 0, :alias, :color,
                0, 0, 2, :body, UTC_TIMESTAMP()
            )
            """.trimIndent()
        )
            .param("podId", podId)
            .param("channelId", channelId)
            .param("alias", SYSTEM_ALIAS)
            .param("color", SYSTEM_COLOR)
            .param("body", body)
            .update(kh)
        return kh.key!!.toLong()
    }

    private fun pickUniqueAliasAndColor(podId: Long, userId: Long): Pair<String, String> {
        val existing = jdbcClient.sql("SELECT alias, alias_color FROM pod_members WHERE pod_id = :podId")
            .param("podId", podId)
            .query { rs, _ -> rs.getString("alias") to rs.getString("alias_color") }
            .list()

        val userOwnAliases = jdbcClient.sql("SELECT alias FROM pod_members WHERE user_id = :userId")
            .param("userId", userId)
            .query(String::class.java)
            .set()

        val takenAliases = existing.map { it.first }.toSet()
        val takenColors = existing.map { it.second }.toSet()

        val preferredAliases = mutableListOf<String>()
        val fallbackAliases = mutableListOf<String>()
        for (adj in ADJECTIVES) {
            for (noun in NOUNS) {
                val candidate = "$adj $noun"
                if (candidate !in takenAliases) {
                    fallbackAliases.add(candidate)
                    if (candidate !in userOwnAliases) {
                        preferredAliases.add(candidate)
                    }
                }
            }
        }

        val pool = preferredAliases.ifEmpty { fallbackAliases }
        val chosenAlias = if (pool.isNotEmpty()) {
            pool[rng.nextInt(pool.size)]
        } else {
            "${ADJECTIVES[rng.nextInt(ADJECTIVES.size)]} ${NOUNS[rng.nextInt(NOUNS.size)]} ${10 + rng.nextInt(90)}"
        }

        val availableColors = COLORS.filter { it !in takenColors }
        val chosenColor = if (availableColors.isNotEmpty()) {
            availableColors[rng.nextInt(availableColors.size)]
        } else {
            COLORS[rng.nextInt(COLORS.size)]
        }
        return chosenAlias to chosenColor
    }

    private fun findOrCreateInterest(rawInput: String): InterestRow {
        val slug = normalizeSlug(rawInput).take(64)
        if (slug.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid interest: $rawInput")
        }

        val found = jdbcClient.sql("SELECT id, slug, label, category FROM interests WHERE slug = :slug LIMIT 1")
            .param("slug", slug)
            .query { rs, _ ->
                InterestRow(
                    id = rs.getLong("id"),
                    slug = rs.getString("slug"),
                    label = rs.getString("label"),
                    category = rs.getString("category")
                )
            }
            .optional()
            .orElse(null)

        if (found != null) return found

        val label = formatInterestLabel(rawInput, slug)
        jdbcClient.sql(
            """
            INSERT INTO interests (slug, label, category, created_at)
            VALUES (:slug, :label, 'custom', UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE id = id
            """.trimIndent()
        )
            .param("slug", slug)
            .param("label", label)
            .update()

        return jdbcClient.sql("SELECT id, slug, label, category FROM interests WHERE slug = :slug LIMIT 1")
            .param("slug", slug)
            .query { rs, _ ->
                InterestRow(
                    id = rs.getLong("id"),
                    slug = rs.getString("slug"),
                    label = rs.getString("label"),
                    category = rs.getString("category")
                )
            }
            .single()
    }

    internal fun normalizeSlug(input: String): String {
        return input.trim()
            .lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
    }

    private fun formatInterestLabel(rawInput: String, slug: String): String {
        val trimmed = rawInput.trim()
        val pretty = if (trimmed.any { it.isUpperCase() || it == ' ' }) {
            trimmed
        } else {
            slug.split('-').joinToString(" ") { part ->
                part.replaceFirstChar { c -> c.titlecase() }
            }
        }
        return pretty.take(64)
    }

    internal fun <T> executeWithDeadlockRetry(maxAttempts: Int = 3, block: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (ex: DataAccessException) {
                if (isRetryableLockError(ex) && attempt < maxAttempts - 1) {
                    Thread.sleep(40L * (1 shl attempt) + rng.nextInt(25))
                    attempt++
                    continue
                }
                throw ex
            }
        }
    }

    private fun isRetryableLockError(ex: Throwable?): Boolean {
        var cur = ex
        while (cur != null) {
            if (cur is PessimisticLockingFailureException || cur is CannotAcquireLockException) {
                return true
            }
            if (cur is SQLException && (cur.errorCode == 1213 || cur.errorCode == 1205 || cur.sqlState == "40001")) {
                return true
            }
            cur = cur.cause
        }
        return false
    }
}
