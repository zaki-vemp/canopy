package com.canopy.pods

import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.util.UuidV7
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import java.sql.ResultSet
import java.time.LocalDateTime
import java.time.ZoneOffset

@Component
class PodProposalReader(
    private val jdbcClient: JdbcClient,
    private val objectMapper: ObjectMapper
) {
    private data class RawProposalRow(
        val id: Long,
        val podPublicBytes: ByteArray,
        val proposerAlias: String,
        val kind: String,
        val title: String,
        val payloadJson: String,
        val targetUserId: Long,
        val targetUserPublicBytes: ByteArray?,
        val targetAlias: String,
        val status: String,
        val yesCount: Int,
        val noCount: Int,
        val eligibleCount: Int,
        val announcementMessageId: Long,
        val expiresAtIso: String,
        val resolvedAtIso: String?,
        val createdAtIso: String
    )

    private val rawProposalMapper = RowMapper { rs: ResultSet, _: Int ->
        val expLdt = rs.getObject("expires_at", LocalDateTime::class.java)
        val resLdt = rs.getObject("resolved_at", LocalDateTime::class.java)
        val creLdt = rs.getObject("created_at", LocalDateTime::class.java)
        RawProposalRow(
            id = rs.getLong("id"),
            podPublicBytes = rs.getBytes("pod_public_id"),
            proposerAlias = rs.getString("proposer_alias"),
            kind = rs.getString("kind"),
            title = rs.getString("title"),
            payloadJson = rs.getString("payload_json") ?: "{}",
            targetUserId = rs.getLong("target_user_id"),
            targetUserPublicBytes = rs.getBytes("target_public_id"),
            targetAlias = rs.getString("target_alias") ?: "",
            status = rs.getString("status"),
            yesCount = rs.getInt("yes_count"),
            noCount = rs.getInt("no_count"),
            eligibleCount = rs.getInt("eligible_count"),
            announcementMessageId = rs.getLong("announcement_message_id"),
            expiresAtIso = (expLdt ?: LocalDateTime.now(ZoneOffset.UTC)).toInstant(ZoneOffset.UTC).toString(),
            resolvedAtIso = resLdt?.toInstant(ZoneOffset.UTC)?.toString(),
            createdAtIso = (creLdt ?: LocalDateTime.now(ZoneOffset.UTC)).toInstant(ZoneOffset.UTC).toString()
        )
    }

    private val baseSelect = """
        SELECT pp.id,
               p.public_id AS pod_public_id,
               pp.proposer_alias,
               pp.kind,
               pp.title,
               pp.payload_json,
               pp.target_user_id,
               tu.public_id AS target_public_id,
               pp.target_alias,
               pp.status,
               pp.yes_count,
               pp.no_count,
               pp.eligible_count,
               pp.announcement_message_id,
               pp.expires_at,
               pp.resolved_at,
               pp.created_at
        FROM pod_proposals pp
        JOIN pods p ON p.id = pp.pod_id
        LEFT JOIN users tu ON tu.id = pp.target_user_id
    """.trimIndent()

    fun loadById(proposalId: Long, callerUserId: Long): PodProposalDto? {
        val rows = jdbcClient.sql("$baseSelect WHERE pp.id = :id LIMIT 1")
            .param("id", proposalId)
            .query(rawProposalMapper)
            .list()
        return hydrate(rows, callerUserId).firstOrNull()
    }

    fun loadByPodId(podInternalId: Long, callerUserId: Long): List<PodProposalDto> {
        val rows = jdbcClient.sql(
            """
            $baseSelect
            WHERE pp.pod_id = :podId
            ORDER BY pp.id DESC
            LIMIT 50
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query(rawProposalMapper)
            .list()
        return hydrate(rows, callerUserId)
    }

    fun loadByAnnouncementMessageIds(
        podIds: List<Long>,
        messageIds: List<Long>,
        callerUserId: Long
    ): Map<Long, PodProposalDto> {
        if (messageIds.isEmpty() || podIds.isEmpty()) return emptyMap()
        val rows = jdbcClient.sql(
            """
            $baseSelect
            WHERE pp.pod_id IN (:podIds)
              AND pp.announcement_message_id IN (:msgIds)
            """.trimIndent()
        )
            .param("podIds", podIds)
            .param("msgIds", messageIds)
            .query(rawProposalMapper)
            .list()
        if (rows.isEmpty()) return emptyMap()
        val dtos = hydrate(rows, callerUserId).associateBy { it.id }
        val result = HashMap<Long, PodProposalDto>()
        for (r in rows) {
            val dto = dtos[r.id]
            if (dto != null && r.announcementMessageId > 0L) {
                result[r.announcementMessageId] = dto
            }
        }
        return result
    }

    private fun hydrate(rows: List<RawProposalRow>, callerUserId: Long): List<PodProposalDto> {
        if (rows.isEmpty()) return emptyList()
        val proposalIds = rows.map { it.id }

        data class RawVote(val userId: Long, val alias: String, val voteYes: Boolean)
        val votesByProp = HashMap<Long, MutableList<RawVote>>()

        jdbcClient.sql(
            """
            SELECT proposal_id, user_id, voter_alias, vote
            FROM pod_proposal_votes
            WHERE proposal_id IN (:ids)
            ORDER BY created_at ASC
            """.trimIndent()
        )
            .param("ids", proposalIds)
            .query { rs ->
                val pid = rs.getLong("proposal_id")
                votesByProp.computeIfAbsent(pid) { mutableListOf() }.add(
                    RawVote(
                        userId = rs.getLong("user_id"),
                        alias = rs.getString("voter_alias"),
                        voteYes = rs.getInt("vote") != 0
                    )
                )
            }

        return rows.map { r ->
            val votes = votesByProp[r.id] ?: emptyList()
            val yesAliases = votes.filter { it.voteYes }.map { it.alias }
            val noAliases = votes.filter { !it.voteYes }.map { it.alias }
            val myVote = if (callerUserId > 0L) {
                votes.firstOrNull { it.userId == callerUserId }?.voteYes
            } else {
                null
            }
            val payloadNode = runCatching { objectMapper.readTree(r.payloadJson) }.getOrNull()
            val reason = payloadNode?.path("reason")?.asText("") ?: ""
            val targetPeerId = if (r.targetUserId > 0L && r.targetUserPublicBytes != null) {
                UuidV7.peerId(r.podPublicBytes, r.targetUserPublicBytes)
            } else {
                payloadNode?.path("targetPeerId")?.asText("")?.takeIf { it.isNotBlank() }
            }

            PodProposalDto(
                id = r.id,
                podId = UuidV7.toHex(r.podPublicBytes),
                kind = r.kind,
                title = r.title,
                reason = reason,
                proposerAlias = r.proposerAlias,
                targetPeerId = targetPeerId,
                targetAlias = r.targetAlias.takeIf { it.isNotBlank() },
                status = r.status,
                yesCount = r.yesCount,
                noCount = r.noCount,
                eligibleCount = r.eligibleCount,
                yesAliases = yesAliases,
                noAliases = noAliases,
                myVote = myVote,
                expiresAt = r.expiresAtIso,
                resolvedAt = r.resolvedAtIso,
                createdAt = r.createdAtIso
            )
        }
    }
}
