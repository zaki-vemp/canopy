package com.canopy.ws

import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.pods.MemberDto
import com.canopy.pods.PodDetailDto
import com.canopy.util.UuidV7
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import java.util.concurrent.ConcurrentHashMap

@Component
class PodRealtimeHub(
    private val jdbcClient: JdbcClient,
    private val objectMapper: ObjectMapper
) {
    private val log = LoggerFactory.getLogger(PodRealtimeHub::class.java)

    data class ConnectedSession(
        val session: WebSocketSession,
        val userId: Long,
        val podInternalId: Long,
        val podIdHex: String,
        val peerId: String,
        val alias: String,
        val color: String
    )

    private data class VoiceMemberState(
        val peerId: String,
        val alias: String,
        val color: String,
        val voiceChannelId: String,
        val muted: Boolean,
        val deafened: Boolean,
        val speaking: Boolean
    )

    // ponytail: single-node in-memory WS/voice/typing state; add Redis Pub/Sub when scaling >1 backend instance
    private val sessionsByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, ConnectedSession>>()
    private val voiceByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, VoiceMemberState>>()
    private val typingByPodChannel = ConcurrentHashMap<String, ConcurrentHashMap<String, Long>>()

    fun registerSession(conn: ConnectedSession) {
        sessionsByPod.computeIfAbsent(conn.podIdHex) { ConcurrentHashMap() }[conn.session.id] = conn
        broadcastPresenceSnapshot(conn.podInternalId, conn.podIdHex)
    }

    fun unregisterSession(session: WebSocketSession) {
        val podIdHex = session.attributes["podPublicIdHex"] as? String ?: return
        val podSessions = sessionsByPod[podIdHex] ?: return
        val removed = podSessions.remove(session.id) ?: return
        if (podSessions.isEmpty()) {
            sessionsByPod.remove(podIdHex, podSessions)
        }

        val stillConnected = podSessions.values.any { it.peerId == removed.peerId && it.session.isOpen }
        if (!stillConnected) {
            clearAllTypingForAlias(podIdHex, removed.alias)
            val leftVoice = voiceByPod[podIdHex]?.remove(removed.peerId)
            if (leftVoice != null) {
                resetDbVoiceChannel(removed.podInternalId, removed.userId)
                broadcastFrame(podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(podIdHex)))
            }
            broadcastPresenceSnapshot(removed.podInternalId, podIdHex)
        }
    }

    fun isPeerOnline(podIdHex: String, peerId: String): Boolean {
        val podSessions = sessionsByPod[podIdHex] ?: return false
        return podSessions.values.any { it.peerId == peerId && it.session.isOpen }
    }

    fun getOnlinePeerIds(podIdHex: String): Set<String> {
        val podSessions = sessionsByPod[podIdHex] ?: return emptySet()
        return podSessions.values.asSequence()
            .filter { it.session.isOpen }
            .map { it.peerId }
            .toSet()
    }

    fun getPeerVoiceChannelId(podIdHex: String, peerId: String): String? {
        return voiceByPod[podIdHex]?.get(peerId)?.voiceChannelId
    }

    fun getVoiceRoster(podIdHex: String): Map<String, List<VoicePeerDto>> {
        val podVoice = voiceByPod[podIdHex] ?: return emptyMap()
        if (podVoice.isEmpty()) return emptyMap()
        val grouped = LinkedHashMap<String, MutableList<VoicePeerDto>>()
        podVoice.values
            .sortedBy { it.alias }
            .forEach { st ->
                grouped.computeIfAbsent(st.voiceChannelId) { mutableListOf() }.add(
                    VoicePeerDto(
                        peerId = st.peerId,
                        alias = st.alias,
                        color = st.color,
                        muted = st.muted,
                        deafened = st.deafened,
                        speaking = st.speaking
                    )
                )
            }
        return grouped
    }

    fun handleClientFrame(conn: ConnectedSession, frame: WsClientFrame) {
        when (frame) {
            is WsClientFrame.TypingIn -> handleTyping(conn, frame)
            is WsClientFrame.VoiceJoinIn -> handleVoiceJoin(conn, frame)
            is WsClientFrame.VoiceLeaveIn -> handleVoiceLeave(conn)
            is WsClientFrame.VoiceStateIn -> handleVoiceState(conn, frame)
            is WsClientFrame.WebRtcSignalIn -> handleWebRtcSignal(conn, frame)
            is WsClientFrame.PingIn -> sendSafe(conn.session, objectMapper.writeValueAsString(WsServerFrame.PongOut()))
            is WsClientFrame.UnknownIn -> Unit
        }
    }

    private fun handleTyping(conn: ConnectedSession, frame: WsClientFrame.TypingIn) {
        val chId = frame.channelId.trim()
        if (chId.isEmpty() || chId.length > 64) return
        val key = "${conn.podIdHex}:$chId"
        if (frame.isTyping) {
            typingByPodChannel.computeIfAbsent(key) { ConcurrentHashMap() }[conn.alias] =
                System.currentTimeMillis() + 8_000L
        } else {
            typingByPodChannel[key]?.remove(conn.alias)
        }
        broadcastFrame(
            conn.podIdHex,
            WsServerFrame.TypingUpdateOut(
                channelId = chId,
                typingAliases = activeTypingAliases(conn.podIdHex, chId)
            )
        )
    }

    fun clearTyping(podIdHex: String, channelIdHex: String, alias: String) {
        val key = "$podIdHex:$channelIdHex"
        val removed = typingByPodChannel[key]?.remove(alias)
        if (removed != null) {
            broadcastFrame(
                podIdHex,
                WsServerFrame.TypingUpdateOut(
                    channelId = channelIdHex,
                    typingAliases = activeTypingAliases(podIdHex, channelIdHex)
                )
            )
        }
    }

    private fun clearAllTypingForAlias(podIdHex: String, alias: String) {
        val prefix = "$podIdHex:"
        typingByPodChannel.forEach { (key, map) ->
            if (key.startsWith(prefix) && map.remove(alias) != null) {
                val chId = key.removePrefix(prefix)
                broadcastFrame(
                    podIdHex,
                    WsServerFrame.TypingUpdateOut(
                        channelId = chId,
                        typingAliases = activeTypingAliases(podIdHex, chId)
                    )
                )
            }
        }
    }

    private fun activeTypingAliases(podIdHex: String, channelIdHex: String): List<String> {
        val map = typingByPodChannel["$podIdHex:$channelIdHex"] ?: return emptyList()
        val now = System.currentTimeMillis()
        val active = mutableListOf<String>()
        map.entries.forEach { (alias, exp) ->
            if (exp > now) {
                active.add(alias)
            } else {
                map.remove(alias, exp)
            }
        }
        return active.sorted()
    }

    private fun handleVoiceJoin(conn: ConnectedSession, frame: WsClientFrame.VoiceJoinIn) {
        val vcBytes = try {
            UuidV7.fromHex(frame.voiceChannelId)
        } catch (_: IllegalArgumentException) {
            return
        }
        val vcRow = jdbcClient.sql(
            """
            SELECT id, public_id
            FROM pod_channels
            WHERE pod_id = :podId AND public_id = :publicId AND kind = 2
            LIMIT 1
            """.trimIndent()
        )
            .param("podId", conn.podInternalId)
            .param("publicId", vcBytes)
            .query { rs, _ -> rs.getLong("id") to UuidV7.toHex(rs.getBytes("public_id")) }
            .optional()
            .orElse(null) ?: return

        val (vcInternalId, vcHex) = vcRow
        jdbcClient.sql("UPDATE pod_members SET voice_channel_id = :vcId WHERE pod_id = :podId AND user_id = :userId")
            .param("vcId", vcInternalId)
            .param("podId", conn.podInternalId)
            .param("userId", conn.userId)
            .update()

        voiceByPod.computeIfAbsent(conn.podIdHex) { ConcurrentHashMap() }[conn.peerId] = VoiceMemberState(
            peerId = conn.peerId,
            alias = conn.alias,
            color = conn.color,
            voiceChannelId = vcHex,
            muted = frame.muted,
            deafened = frame.deafened,
            speaking = false
        )
        broadcastFrame(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(conn.podIdHex)))
        broadcastPresenceSnapshot(conn.podInternalId, conn.podIdHex)
    }

    private fun handleVoiceLeave(conn: ConnectedSession) {
        voiceByPod[conn.podIdHex]?.remove(conn.peerId)
        resetDbVoiceChannel(conn.podInternalId, conn.userId)
        broadcastFrame(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(conn.podIdHex)))
        broadcastPresenceSnapshot(conn.podInternalId, conn.podIdHex)
    }

    private fun handleVoiceState(conn: ConnectedSession, frame: WsClientFrame.VoiceStateIn) {
        val updated = voiceByPod[conn.podIdHex]?.computeIfPresent(conn.peerId) { _, prev ->
            prev.copy(
                muted = frame.muted,
                deafened = frame.deafened,
                speaking = frame.speaking && !frame.muted && !frame.deafened
            )
        }
        if (updated != null) {
            broadcastFrame(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(conn.podIdHex)))
        }
    }

    private fun handleWebRtcSignal(conn: ConnectedSession, frame: WsClientFrame.WebRtcSignalIn) {
        val targetPeer = frame.targetPeerId.trim()
        if (targetPeer.isEmpty() || targetPeer == conn.peerId) return
        val podSessions = sessionsByPod[conn.podIdHex] ?: return
        val out = WsServerFrame.WebRtcSignalOut(
            voiceChannelId = frame.voiceChannelId,
            fromPeerId = conn.peerId,
            fromAlias = conn.alias,
            signal = frame.signal
        )
        val json = objectMapper.writeValueAsString(out)
        podSessions.values.forEach { target ->
            if (target.peerId == targetPeer && target.session.isOpen) {
                sendSafe(target.session, json)
            }
        }
    }

    fun broadcastToPod(podIdHex: String, payloadMap: Map<String, Any?>) {
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return
        val json = objectMapper.writeValueAsString(payloadMap)
        podSessions.values.forEach { target -> sendSafe(target.session, json) }
    }

    fun broadcastFrame(podIdHex: String, frame: WsServerFrame) {
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return

        when (frame) {
            is WsServerFrame.MemberJoinedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(member = frame.member.copy(isSelf = frame.member.peerId == target.peerId))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.MessageCreatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(message = frame.message.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.MessageUpdatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(message = frame.message.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.ReactionUpdatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(message = frame.message.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.PinUpdatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(message = frame.message.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.PollUpdatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(message = frame.message.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.ThreadReplyCreatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(reply = frame.reply.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.ProposalUpdatedOut -> {
                podSessions.values.forEach { target ->
                    val personalized = frame.copy(proposal = frame.proposal.personalizedForAlias(target.alias))
                    sendSafe(target.session, objectMapper.writeValueAsString(personalized))
                }
            }
            is WsServerFrame.PodUpdatedOut -> {
                broadcastPodUpdated(frame.pod)
            }
            else -> {
                val json = objectMapper.writeValueAsString(frame)
                podSessions.values.forEach { target -> sendSafe(target.session, json) }
            }
        }
    }

    fun broadcastPodUpdated(pod: PodDetailDto) {
        val podSessions = sessionsByPod[pod.podId] ?: return
        if (podSessions.isEmpty()) return
        podSessions.values.forEach { target ->
            val selfMember = pod.members.firstOrNull { it.peerId == target.peerId }
            val personalized = pod.copy(
                myPeerId = target.peerId,
                myAlias = selfMember?.alias ?: target.alias,
                myColor = selfMember?.color ?: target.color,
                myRole = selfMember?.role ?: "MEMBER",
                myStatus = selfMember?.customStatus ?: "",
                members = pod.members.map { m -> m.copy(isSelf = m.peerId == target.peerId) }
            )
            sendSafe(target.session, objectMapper.writeValueAsString(WsServerFrame.PodUpdatedOut(pod = personalized)))
        }
    }

    fun evictVoiceChannel(podIdHex: String, channelIdHex: String) {
        val podVoice = voiceByPod[podIdHex] ?: return
        var removedAny = false
        podVoice.entries.forEach { (peerId, st) ->
            if (st.voiceChannelId == channelIdHex && podVoice.remove(peerId, st)) {
                removedAny = true
            }
        }
        if (removedAny) {
            broadcastFrame(podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(podIdHex)))
        }
    }

    fun broadcastPresenceSnapshot(podInternalId: Long, podIdHex: String) {
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return

        val podPublicBytes = UuidV7.fromHex(podIdHex)
        val onlinePeers = getOnlinePeerIds(podIdHex)
        val roster = getVoiceRoster(podIdHex)

        val baseMembers = jdbcClient.sql(
            """
            SELECT u.public_id AS user_public_id,
                   pm.alias,
                   pm.alias_color,
                   pm.role,
                   pm.custom_status,
                   vc.public_id AS vc_public_id
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            LEFT JOIN pod_channels vc ON vc.id = pm.voice_channel_id AND vc.pod_id = pm.pod_id
            WHERE pm.pod_id = :podId
            ORDER BY pm.joined_at ASC
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ ->
                val peerId = UuidV7.peerId(podPublicBytes, rs.getBytes("user_public_id"))
                val dbVcHex = rs.getBytes("vc_public_id")?.let { UuidV7.toHex(it) }
                val activeVc = getPeerVoiceChannelId(podIdHex, peerId) ?: if (peerId in onlinePeers) dbVcHex else null
                MemberDto(
                    peerId = peerId,
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color"),
                    role = rs.getString("role") ?: "MEMBER",
                    customStatus = rs.getString("custom_status") ?: "",
                    online = peerId in onlinePeers,
                    voiceChannelId = activeVc,
                    isSelf = false
                )
            }
            .list()

        val sortedOnline = onlinePeers.sorted()
        podSessions.values.forEach { target ->
            val personalizedMembers = baseMembers.map { m -> m.copy(isSelf = m.peerId == target.peerId) }
            val snapshot = WsServerFrame.PresenceSnapshotOut(
                podId = podIdHex,
                selfPeerId = target.peerId,
                onlinePeerIds = sortedOnline,
                members = personalizedMembers,
                voiceRoster = roster
            )
            sendSafe(target.session, objectMapper.writeValueAsString(snapshot))
        }
    }

    fun evictMember(podIdHex: String, peerId: String, alias: String) {
        clearAllTypingForAlias(podIdHex, alias)
        val hadVoice = voiceByPod[podIdHex]?.remove(peerId) != null

        val podSessions = sessionsByPod[podIdHex]
        var remainingPodInternalId: Long? = null
        if (podSessions != null) {
            val toClose = mutableListOf<WebSocketSession>()
            podSessions.entries.forEach { (sid, conn) ->
                if (conn.peerId == peerId) {
                    podSessions.remove(sid)
                    toClose.add(conn.session)
                } else if (remainingPodInternalId == null) {
                    remainingPodInternalId = conn.podInternalId
                }
            }
            toClose.forEach { ws ->
                try {
                    synchronized(ws) {
                        if (ws.isOpen) {
                            ws.close(CloseStatus.NORMAL)
                        }
                    }
                } catch (_: Exception) {
                }
            }
        }

        broadcastFrame(podIdHex, WsServerFrame.MemberLeftOut(peerId = peerId, alias = alias))
        if (hadVoice) {
            broadcastFrame(podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voiceRoster = getVoiceRoster(podIdHex)))
        }
        if (remainingPodInternalId != null) {
            broadcastPresenceSnapshot(remainingPodInternalId!!, podIdHex)
        }
    }

    private fun resetDbVoiceChannel(podInternalId: Long, userId: Long) {
        try {
            jdbcClient.sql("UPDATE pod_members SET voice_channel_id = 0 WHERE pod_id = :podId AND user_id = :userId")
                .param("podId", podInternalId)
                .param("userId", userId)
                .update()
        } catch (ex: Exception) {
            log.debug("Voice channel DB reset skipped: {}", ex.message)
        }
    }

    private fun sendSafe(session: WebSocketSession, json: String) {
        try {
            synchronized(session) {
                if (session.isOpen) {
                    session.sendMessage(TextMessage(json))
                }
            }
        } catch (ex: Exception) {
            log.debug("WebSocket send failed for session {}: {}", session.id, ex.message)
        }
    }
}
