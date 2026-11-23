package com.canopy.ws

import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.pods.DmSummaryDto
import com.canopy.pods.MemberDto
import com.canopy.pods.PodDetailDto
import com.canopy.util.UuidV7
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import java.time.LocalDateTime
import java.time.ZoneOffset
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
        val muted: Boolean,
        val deafened: Boolean,
        val speaking: Boolean
    )

    private data class ActiveDmTyping(
        val senderUserId: Long,
        val senderPeerId: String,
        val senderAlias: String,
        val targetUserId: Long,
        val targetPeerId: String,
        val expiresAtMs: Long
    )

    private data class ResolvedWsMember(
        val userId: Long,
        val peerId: String,
        val alias: String,
        val color: String
    )

    private data class DmCallKey(
        val podIdHex: String,
        val lowUserId: Long,
        val highUserId: Long
    )

    private data class DmCallSession(
        val podIdHex: String,
        val lowUserId: Long,
        val highUserId: Long,
        val callerUserId: Long,
        val callerPeerId: String,
        val callerAlias: String,
        val callerColor: String,
        val calleeUserId: Long,
        val calleePeerId: String,
        val calleeAlias: String,
        val calleeColor: String,
        val status: String // "RINGING" | "CONNECTED"
    )

    // ponytail: single-node in-memory WS/voice/typing/1:1-call state; add Redis Pub/Sub when scaling >1 backend instance
    private val sessionsByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, ConnectedSession>>()
    private val voiceByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, VoiceMemberState>>()
    private val groupTypingByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, Long>>()
    private val dmTypingByPod = ConcurrentHashMap<String, ConcurrentHashMap<String, ActiveDmTyping>>()
    private val dmCalls = ConcurrentHashMap<DmCallKey, DmCallSession>()

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
            clearAllTypingForMember(podIdHex, removed.peerId, removed.alias)
            terminateDmCallsForPeer(podIdHex, removed.peerId, "disconnected")
            val leftVoice = voiceByPod[podIdHex]?.remove(removed.peerId)
            if (leftVoice != null) {
                setDbInVoice(removed.podInternalId, removed.userId, false)
                broadcastToPod(podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voicePeers = getVoicePeers(podIdHex)))
            } else {
                setDbInVoice(removed.podInternalId, removed.userId, false)
            }
            broadcastPresenceSnapshot(removed.podInternalId, podIdHex)
        }
    }

    fun isPeerOnline(podIdHex: String, peerId: String): Boolean {
        val podSessions = sessionsByPod[podIdHex] ?: return false
        return podSessions.values.any { it.peerId == peerId && it.session.isOpen }
    }

    fun isPeerInVoice(podIdHex: String, peerId: String): Boolean {
        return voiceByPod[podIdHex]?.containsKey(peerId) == true
    }

    fun getOnlinePeerIds(podIdHex: String): Set<String> {
        val podSessions = sessionsByPod[podIdHex] ?: return emptySet()
        return podSessions.values.asSequence()
            .filter { it.session.isOpen }
            .map { it.peerId }
            .toSet()
    }

    fun getVoicePeers(podIdHex: String): List<VoicePeerDto> {
        val podVoice = voiceByPod[podIdHex] ?: return emptyList()
        if (podVoice.isEmpty()) return emptyList()
        return podVoice.values
            .sortedBy { it.alias }
            .map { st ->
                VoicePeerDto(
                    peerId = st.peerId,
                    alias = st.alias,
                    color = st.color,
                    muted = st.muted,
                    deafened = st.deafened,
                    speaking = st.speaking
                )
            }
    }

    fun handleClientFrame(conn: ConnectedSession, frame: WsClientFrame) {
        when (frame) {
            is WsClientFrame.TypingIn -> handleTyping(conn, frame)
            is WsClientFrame.VoiceJoinIn -> handleVoiceJoin(conn, frame)
            is WsClientFrame.VoiceLeaveIn -> handleVoiceLeave(conn)
            is WsClientFrame.VoiceStateIn -> handleVoiceState(conn, frame)
            is WsClientFrame.DmCallRingIn -> handleDmCallRing(conn, frame)
            is WsClientFrame.DmCallAcceptIn -> handleDmCallAccept(conn, frame)
            is WsClientFrame.DmCallDeclineIn -> handleDmCallDecline(conn, frame)
            is WsClientFrame.DmCallEndIn -> handleDmCallEnd(conn, frame)
            is WsClientFrame.DmCallStateIn -> handleDmCallState(conn, frame)
            is WsClientFrame.WebRtcSignalIn -> handleWebRtcSignal(conn, frame)
            is WsClientFrame.PingIn -> sendSafe(conn.session, objectMapper.writeValueAsString(WsServerFrame.PongOut()))
            is WsClientFrame.UnknownIn -> Unit
        }
    }

    private fun handleTyping(conn: ConnectedSession, frame: WsClientFrame.TypingIn) {
        val rawTarget = frame.targetPeerId?.trim()?.takeIf { it.isNotEmpty() }
        if (rawTarget == null) {
            if (frame.isTyping) {
                groupTypingByPod.computeIfAbsent(conn.podIdHex) { ConcurrentHashMap() }[conn.alias] =
                    System.currentTimeMillis() + 8_000L
            } else {
                groupTypingByPod[conn.podIdHex]?.remove(conn.alias)
            }
            broadcastToPod(
                conn.podIdHex,
                WsServerFrame.TypingUpdateOut(
                    targetPeerId = null,
                    fromPeerId = null,
                    typingAliases = activeGroupTypingAliases(conn.podIdHex)
                )
            )
            return
        }

        if (rawTarget.length > 32 || rawTarget == conn.peerId) return
        val podPublicBytes = runCatching { UuidV7.fromHex(conn.podIdHex) }.getOrNull() ?: return
        val target = resolveMemberByPeerId(conn.podInternalId, podPublicBytes, rawTarget) ?: return
        if (target.userId == conn.userId) return

        val pairKey = "${conn.peerId}->$rawTarget"
        if (frame.isTyping) {
            dmTypingByPod.computeIfAbsent(conn.podIdHex) { ConcurrentHashMap() }[pairKey] = ActiveDmTyping(
                senderUserId = conn.userId,
                senderPeerId = conn.peerId,
                senderAlias = conn.alias,
                targetUserId = target.userId,
                targetPeerId = rawTarget,
                expiresAtMs = System.currentTimeMillis() + 8_000L
            )
        } else {
            dmTypingByPod[conn.podIdHex]?.remove(pairKey)
        }

        sendToUsers(
            conn.podIdHex,
            setOf(conn.userId, target.userId),
            WsServerFrame.TypingUpdateOut(
                targetPeerId = rawTarget,
                fromPeerId = conn.peerId,
                typingAliases = if (frame.isTyping) listOf(conn.alias) else emptyList()
            )
        )
    }

    fun clearGroupTyping(podIdHex: String, alias: String) {
        val removed = groupTypingByPod[podIdHex]?.remove(alias)
        if (removed != null) {
            broadcastToPod(
                podIdHex,
                WsServerFrame.TypingUpdateOut(
                    targetPeerId = null,
                    fromPeerId = null,
                    typingAliases = activeGroupTypingAliases(podIdHex)
                )
            )
        }
    }

    fun clearDmTyping(
        podIdHex: String,
        senderUserId: Long,
        senderPeerId: String,
        targetUserId: Long,
        targetPeerId: String
    ) {
        val pairKey = "$senderPeerId->$targetPeerId"
        val removed = dmTypingByPod[podIdHex]?.remove(pairKey)
        if (removed != null) {
            sendToUsers(
                podIdHex,
                setOf(senderUserId, targetUserId),
                WsServerFrame.TypingUpdateOut(
                    targetPeerId = targetPeerId,
                    fromPeerId = senderPeerId,
                    typingAliases = emptyList()
                )
            )
        }
    }

    private fun clearAllTypingForMember(podIdHex: String, peerId: String, alias: String) {
        if (groupTypingByPod[podIdHex]?.remove(alias) != null) {
            broadcastToPod(
                podIdHex,
                WsServerFrame.TypingUpdateOut(
                    targetPeerId = null,
                    fromPeerId = null,
                    typingAliases = activeGroupTypingAliases(podIdHex)
                )
            )
        }

        val dmMap = dmTypingByPod[podIdHex] ?: return
        val prefix = "$peerId->"
        dmMap.entries.forEach { (key, entry) ->
            if (key.startsWith(prefix) && dmMap.remove(key, entry)) {
                sendToUsers(
                    podIdHex,
                    setOf(entry.senderUserId, entry.targetUserId),
                    WsServerFrame.TypingUpdateOut(
                        targetPeerId = entry.targetPeerId,
                        fromPeerId = entry.senderPeerId,
                        typingAliases = emptyList()
                    )
                )
            }
        }
    }

    private fun activeGroupTypingAliases(podIdHex: String): List<String> {
        val map = groupTypingByPod[podIdHex] ?: return emptyList()
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

    private fun resolveMemberByPeerId(
        podInternalId: Long,
        podPublicBytes: ByteArray,
        targetPeerId: String
    ): ResolvedWsMember? {
        return jdbcClient.sql(
            """
            SELECT pm.user_id, u.public_id AS user_public_id, pm.alias, pm.alias_color
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id = :podId
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ ->
                ResolvedWsMember(
                    userId = rs.getLong("user_id"),
                    peerId = UuidV7.peerId(podPublicBytes, rs.getBytes("user_public_id")),
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color")
                )
            }
            .list()
            .firstOrNull { it.peerId == targetPeerId }
    }

    private fun handleVoiceJoin(conn: ConnectedSession, frame: WsClientFrame.VoiceJoinIn) {
        setDbInVoice(conn.podInternalId, conn.userId, true)
        voiceByPod.computeIfAbsent(conn.podIdHex) { ConcurrentHashMap() }[conn.peerId] = VoiceMemberState(
            peerId = conn.peerId,
            alias = conn.alias,
            color = conn.color,
            muted = frame.muted,
            deafened = frame.deafened,
            speaking = false
        )
        broadcastToPod(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voicePeers = getVoicePeers(conn.podIdHex)))
        broadcastPresenceSnapshot(conn.podInternalId, conn.podIdHex)
    }

    private fun handleVoiceLeave(conn: ConnectedSession) {
        voiceByPod[conn.podIdHex]?.remove(conn.peerId)
        setDbInVoice(conn.podInternalId, conn.userId, false)
        broadcastToPod(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voicePeers = getVoicePeers(conn.podIdHex)))
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
            broadcastToPod(conn.podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voicePeers = getVoicePeers(conn.podIdHex)))
        }
    }

    private fun handleDmCallRing(conn: ConnectedSession, frame: WsClientFrame.DmCallRingIn) {
        val targetPeer = frame.targetPeerId.trim()
        if (targetPeer.isEmpty() || targetPeer.length > 32 || targetPeer == conn.peerId) return
        val podPublicBytes = runCatching { UuidV7.fromHex(conn.podIdHex) }.getOrNull() ?: return
        val target = resolveMemberByPeerId(conn.podInternalId, podPublicBytes, targetPeer) ?: return
        if (target.userId == conn.userId) return

        val low = minOf(conn.userId, target.userId)
        val high = maxOf(conn.userId, target.userId)
        val key = DmCallKey(conn.podIdHex, low, high)

        // End any other 1:1 call this caller had active in this pod before ringing a new peer
        dmCalls.entries.forEach { (k, existing) ->
            if (k.podIdHex == conn.podIdHex && k != key &&
                (existing.callerUserId == conn.userId || existing.calleeUserId == conn.userId)
            ) {
                if (dmCalls.remove(k, existing)) {
                    sendToUsers(
                        conn.podIdHex,
                        setOf(existing.lowUserId, existing.highUserId),
                        WsServerFrame.DmCallEndedOut(byPeerId = conn.peerId, reason = "ended")
                    )
                }
            }
        }

        dmCalls[key] = DmCallSession(
            podIdHex = conn.podIdHex,
            lowUserId = low,
            highUserId = high,
            callerUserId = conn.userId,
            callerPeerId = conn.peerId,
            callerAlias = conn.alias,
            callerColor = conn.color,
            calleeUserId = target.userId,
            calleePeerId = target.peerId,
            calleeAlias = target.alias,
            calleeColor = target.color,
            status = "RINGING"
        )

        val targetOnline = isPeerOnline(conn.podIdHex, target.peerId)
        sendToUsers(
            conn.podIdHex,
            setOf(conn.userId),
            WsServerFrame.DmCallRingingOut(
                targetPeerId = target.peerId,
                targetAlias = target.alias,
                targetColor = target.color,
                targetOnline = targetOnline
            )
        )
        if (targetOnline) {
            sendToUsers(
                conn.podIdHex,
                setOf(target.userId),
                WsServerFrame.DmCallIncomingOut(
                    fromPeerId = conn.peerId,
                    fromAlias = conn.alias,
                    fromColor = conn.color
                )
            )
        }
    }

    private fun handleDmCallAccept(conn: ConnectedSession, frame: WsClientFrame.DmCallAcceptIn) {
        val callerPeer = frame.callerPeerId.trim()
        if (callerPeer.isEmpty() || callerPeer == conn.peerId) return

        val entry = dmCalls.entries.firstOrNull { (k, s) ->
            k.podIdHex == conn.podIdHex && s.calleeUserId == conn.userId && s.callerPeerId == callerPeer
        } ?: return

        val connected = entry.value.copy(status = "CONNECTED")
        dmCalls[entry.key] = connected

        sendToUsers(
            conn.podIdHex,
            setOf(connected.lowUserId, connected.highUserId),
            WsServerFrame.DmCallConnectedOut(
                peerAId = connected.callerPeerId,
                peerAAlias = connected.callerAlias,
                peerBId = connected.calleePeerId,
                peerBAlias = connected.calleeAlias
            )
        )
    }

    private fun handleDmCallDecline(conn: ConnectedSession, frame: WsClientFrame.DmCallDeclineIn) {
        val callerPeer = frame.callerPeerId.trim()
        if (callerPeer.isEmpty() || callerPeer == conn.peerId) return

        val entry = dmCalls.entries.firstOrNull { (k, s) ->
            k.podIdHex == conn.podIdHex &&
                ((s.calleeUserId == conn.userId && s.callerPeerId == callerPeer) ||
                    (s.callerUserId == conn.userId && s.calleePeerId == callerPeer))
        } ?: return

        if (dmCalls.remove(entry.key, entry.value)) {
            sendToUsers(
                conn.podIdHex,
                setOf(entry.value.lowUserId, entry.value.highUserId),
                WsServerFrame.DmCallEndedOut(byPeerId = conn.peerId, reason = "declined")
            )
        }
    }

    private fun handleDmCallEnd(conn: ConnectedSession, frame: WsClientFrame.DmCallEndIn) {
        val peer = frame.peerId.trim()
        val matching = dmCalls.entries.filter { (k, s) ->
            k.podIdHex == conn.podIdHex &&
                (s.callerUserId == conn.userId || s.calleeUserId == conn.userId) &&
                (peer.isEmpty() || s.callerPeerId == peer || s.calleePeerId == peer)
        }
        matching.forEach { (k, s) ->
            if (dmCalls.remove(k, s)) {
                sendToUsers(
                    conn.podIdHex,
                    setOf(s.lowUserId, s.highUserId),
                    WsServerFrame.DmCallEndedOut(byPeerId = conn.peerId, reason = "ended")
                )
            }
        }
    }

    private fun handleDmCallState(conn: ConnectedSession, frame: WsClientFrame.DmCallStateIn) {
        val peer = frame.peerId.trim()
        val active = dmCalls.entries.firstOrNull { (k, s) ->
            k.podIdHex == conn.podIdHex &&
                (s.callerUserId == conn.userId || s.calleeUserId == conn.userId) &&
                (peer.isEmpty() || s.callerPeerId == peer || s.calleePeerId == peer)
        }?.value ?: return

        sendToUsers(
            conn.podIdHex,
            setOf(active.lowUserId, active.highUserId),
            WsServerFrame.DmCallStateOut(
                fromPeerId = conn.peerId,
                muted = frame.muted,
                speaking = frame.speaking && !frame.muted
            )
        )
    }

    private fun terminateDmCallsForPeer(podIdHex: String, peerId: String, reason: String) {
        dmCalls.entries.forEach { (k, s) ->
            if (k.podIdHex == podIdHex && (s.callerPeerId == peerId || s.calleePeerId == peerId)) {
                if (dmCalls.remove(k, s)) {
                    sendToUsers(
                        podIdHex,
                        setOf(s.lowUserId, s.highUserId),
                        WsServerFrame.DmCallEndedOut(byPeerId = peerId, reason = reason)
                    )
                }
            }
        }
    }

    private fun handleWebRtcSignal(conn: ConnectedSession, frame: WsClientFrame.WebRtcSignalIn) {
        val targetPeer = frame.targetPeerId.trim()
        if (targetPeer.isEmpty() || targetPeer == conn.peerId) return

        val normalizedScope = frame.scope.trim().uppercase().ifEmpty { "GROUP" }
        if (normalizedScope == "DM") {
            val activeDmCall = dmCalls.entries.firstOrNull { (k, s) ->
                k.podIdHex == conn.podIdHex &&
                    ((s.callerPeerId == conn.peerId && s.calleePeerId == targetPeer) ||
                        (s.calleePeerId == conn.peerId && s.callerPeerId == targetPeer))
            }?.value ?: return

            val targetUserId = if (activeDmCall.callerUserId == conn.userId) {
                activeDmCall.calleeUserId
            } else {
                activeDmCall.callerUserId
            }
            sendToUsers(
                conn.podIdHex,
                setOf(targetUserId),
                WsServerFrame.WebRtcSignalOut(
                    fromPeerId = conn.peerId,
                    fromAlias = conn.alias,
                    scope = "DM",
                    signal = frame.signal
                )
            )
            return
        }

        val podVoice = voiceByPod[conn.podIdHex] ?: return
        if (!podVoice.containsKey(conn.peerId) || !podVoice.containsKey(targetPeer)) return

        val podSessions = sessionsByPod[conn.podIdHex] ?: return
        val out = WsServerFrame.WebRtcSignalOut(
            fromPeerId = conn.peerId,
            fromAlias = conn.alias,
            scope = "GROUP",
            signal = frame.signal
        )
        val json = objectMapper.writeValueAsString(out)
        podSessions.values.forEach { target ->
            if (target.peerId == targetPeer && target.session.isOpen) {
                sendSafe(target.session, json)
            }
        }
    }

    fun sendToUsers(podIdHex: String, userIds: Set<Long>, frame: WsServerFrame) {
        if (userIds.isEmpty()) return
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return

        podSessions.values.forEach { target ->
            if (target.userId in userIds && target.session.isOpen) {
                val personalized = personalizeFrameForTarget(frame, target)
                sendSafe(target.session, objectMapper.writeValueAsString(personalized))
            }
        }
    }

    fun broadcastToPod(podIdHex: String, frame: WsServerFrame) {
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return

        if (frame is WsServerFrame.PodUpdatedOut) {
            broadcastPodUpdated(frame.pod)
            return
        }

        podSessions.values.forEach { target ->
            if (target.session.isOpen) {
                val personalized = personalizeFrameForTarget(frame, target)
                sendSafe(target.session, objectMapper.writeValueAsString(personalized))
            }
        }
    }

    fun broadcastFrame(podIdHex: String, frame: WsServerFrame) {
        broadcastToPod(podIdHex, frame)
    }

    private fun personalizeFrameForTarget(frame: WsServerFrame, target: ConnectedSession): WsServerFrame {
        return when (frame) {
            is WsServerFrame.MemberJoinedOut ->
                frame.copy(member = frame.member.copy(isSelf = frame.member.peerId == target.peerId))
            is WsServerFrame.MessageCreatedOut ->
                frame.copy(message = frame.message.personalizedForAlias(target.alias))
            is WsServerFrame.MessageUpdatedOut ->
                frame.copy(message = frame.message.personalizedForAlias(target.alias))
            is WsServerFrame.ReactionUpdatedOut ->
                frame.copy(message = frame.message.personalizedForAlias(target.alias))
            is WsServerFrame.PinUpdatedOut ->
                frame.copy(message = frame.message.personalizedForAlias(target.alias))
            is WsServerFrame.PollUpdatedOut ->
                frame.copy(message = frame.message.personalizedForAlias(target.alias))
            is WsServerFrame.ProposalUpdatedOut ->
                frame.copy(proposal = frame.proposal.personalizedForAlias(target.alias))
            else -> frame
        }
    }

    fun broadcastPodUpdated(pod: PodDetailDto) {
        val podSessions = sessionsByPod[pod.podId] ?: return
        if (podSessions.isEmpty()) return

        val dmCacheByUser = HashMap<Long, List<DmSummaryDto>>()
        val unreadGroupCacheByUser = HashMap<Long, Int>()

        podSessions.values.forEach { target ->
            if (!target.session.isOpen) return@forEach
            val selfMember = pod.members.firstOrNull { it.peerId == target.peerId }
            val myDms = dmCacheByUser.computeIfAbsent(target.userId) { uid ->
                loadDmSummariesByPod(uid, listOf(target.podInternalId))[target.podInternalId] ?: emptyList()
            }
            val myUnreadGroup = unreadGroupCacheByUser.computeIfAbsent(target.userId) { uid ->
                loadUnreadGroupCountsByPod(uid, listOf(target.podInternalId))[target.podInternalId] ?: 0
            }
            val personalized = pod.copy(
                myPeerId = target.peerId,
                myAlias = selfMember?.alias ?: target.alias,
                myColor = selfMember?.color ?: target.color,
                myRole = selfMember?.role ?: "MEMBER",
                myStatus = selfMember?.customStatus ?: "",
                unreadGroupCount = myUnreadGroup,
                dmConversations = myDms,
                members = pod.members.map { m -> m.copy(isSelf = m.peerId == target.peerId) }
            )
            sendSafe(target.session, objectMapper.writeValueAsString(WsServerFrame.PodUpdatedOut(pod = personalized)))
        }
    }

    fun broadcastPresenceSnapshot(podInternalId: Long, podIdHex: String) {
        val podSessions = sessionsByPod[podIdHex] ?: return
        if (podSessions.isEmpty()) return

        val podPublicBytes = UuidV7.fromHex(podIdHex)
        val onlinePeers = getOnlinePeerIds(podIdHex)
        val voicePeers = getVoicePeers(podIdHex)

        val baseMembers = jdbcClient.sql(
            """
            SELECT u.public_id AS user_public_id,
                   pm.alias,
                   pm.alias_color,
                   pm.role,
                   pm.custom_status,
                   pm.in_voice
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
            WHERE pm.pod_id = :podId
            ORDER BY pm.joined_at ASC
            """.trimIndent()
        )
            .param("podId", podInternalId)
            .query { rs, _ ->
                val peerId = UuidV7.peerId(podPublicBytes, rs.getBytes("user_public_id"))
                val online = peerId in onlinePeers
                val inVoice = isPeerInVoice(podIdHex, peerId) || (online && rs.getInt("in_voice") != 0)
                MemberDto(
                    peerId = peerId,
                    alias = rs.getString("alias"),
                    color = rs.getString("alias_color"),
                    role = rs.getString("role") ?: "MEMBER",
                    customStatus = rs.getString("custom_status") ?: "",
                    online = online,
                    inVoice = inVoice,
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
                voicePeers = voicePeers
            )
            sendSafe(target.session, objectMapper.writeValueAsString(snapshot))
        }
    }

    fun evictMember(podIdHex: String, peerId: String, alias: String) {
        clearAllTypingForMember(podIdHex, peerId, alias)
        terminateDmCallsForPeer(podIdHex, peerId, "disconnected")
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

        broadcastToPod(podIdHex, WsServerFrame.MemberLeftOut(peerId = peerId, alias = alias))
        if (hadVoice) {
            broadcastToPod(podIdHex, WsServerFrame.VoiceRosterUpdatedOut(voicePeers = getVoicePeers(podIdHex)))
        }
        if (remainingPodInternalId != null) {
            broadcastPresenceSnapshot(remainingPodInternalId!!, podIdHex)
        }
    }

    /**
     * Batch-loads unread Group Chat counts across `podIds` for `callerUserId` using
     * `pod_read_cursors.PRIMARY` + `idx_messages_convo_cursor` range scan (`id > myGroupLastReadId`).
     */
    fun loadUnreadGroupCountsByPod(callerUserId: Long, podIds: List<Long>): Map<Long, Int> {
        if (callerUserId <= 0L || podIds.isEmpty()) return emptyMap()
        val counts = HashMap<Long, Int>()
        jdbcClient.sql(
            """
            SELECT pm.pod_id, COUNT(m.id) AS unread_cnt
            FROM pod_members pm
            LEFT JOIN pod_read_cursors prc
              ON prc.pod_id = pm.pod_id
             AND prc.user_id = pm.user_id
             AND prc.peer_user_id = 0
            JOIN messages m FORCE INDEX (idx_messages_convo_cursor)
              ON m.pod_id = pm.pod_id
             AND m.dm_user_low_id = 0
             AND m.dm_user_high_id = 0
             AND m.id > COALESCE(prc.last_read_message_id, 0)
            WHERE pm.user_id = :userId
              AND pm.pod_id IN (:podIds)
              AND m.is_deleted = 0
              AND m.sender_user_id != :userId
            GROUP BY pm.pod_id
            """.trimIndent()
        )
            .param("userId", callerUserId)
            .param("podIds", podIds)
            .query { rs ->
                counts[rs.getLong("pod_id")] = rs.getInt("unread_cnt")
            }
        return counts
    }

    /**
     * Batch-loads 1:1 DM conversation summaries (`lastMessageId DESC`), `unreadCount`, and
     * `peerLastReadMessageId` (`Seen ✓✓`) for `callerUserId` across `podIds` with zero N+1 queries.
     */
    fun loadDmSummariesByPod(callerUserId: Long, podIds: List<Long>): Map<Long, List<DmSummaryDto>> {
        if (callerUserId <= 0L || podIds.isEmpty()) return emptyMap()

        val lastMsgIds = jdbcClient.sql(
            """
            SELECT MAX(id) AS last_msg_id
            FROM messages FORCE INDEX (idx_messages_convo_cursor)
            WHERE pod_id IN (:podIds) AND dm_user_low_id = :userId
            GROUP BY pod_id, dm_user_high_id
            UNION ALL
            SELECT MAX(id) AS last_msg_id
            FROM messages FORCE INDEX (idx_messages_dm_high)
            WHERE pod_id IN (:podIds) AND dm_user_high_id = :userId AND dm_user_low_id > 0
            GROUP BY pod_id, dm_user_low_id
            """.trimIndent()
        )
            .param("podIds", podIds)
            .param("userId", callerUserId)
            .query { rs, _ -> rs.getLong("last_msg_id") }
            .list()
            .filter { it > 0L }
            .distinct()

        if (lastMsgIds.isEmpty()) return emptyMap()

        data class RawDmSummaryRow(
            val msgId: Long,
            val podInternalId: Long,
            val podPublicBytes: ByteArray,
            val senderUserId: Long,
            val senderAlias: String,
            val senderColor: String,
            val recipientUserId: Long,
            val recipientAlias: String,
            val msgType: Int,
            val body: String,
            val isDeleted: Boolean,
            val createdAtIso: String,
            val callerPublicBytes: ByteArray,
            val callerLiveAlias: String?,
            val peerUserId: Long,
            val peerPublicBytes: ByteArray,
            val peerLiveAlias: String?,
            val peerLiveColor: String?,
            val myLastReadId: Long,
            val peerLastReadId: Long
        )

        val rows = jdbcClient.sql(
            """
            SELECT m.id,
                   m.pod_id,
                   p.public_id AS pod_public_id,
                   m.sender_user_id,
                   m.sender_alias,
                   m.sender_color,
                   m.recipient_user_id,
                   m.recipient_alias,
                   m.msg_type,
                   m.body,
                   m.is_deleted,
                   m.created_at,
                   caller_u.public_id AS caller_public_id,
                   caller_pm.alias AS caller_live_alias,
                   peer_u.id AS peer_uid,
                   peer_u.public_id AS peer_public_id,
                   peer_pm.alias AS peer_live_alias,
                   peer_pm.alias_color AS peer_live_color,
                   COALESCE(my_rc.last_read_message_id, 0) AS my_last_read_id,
                   COALESCE(peer_rc.last_read_message_id, 0) AS peer_last_read_id
            FROM messages m
            JOIN pods p ON p.id = m.pod_id
            JOIN users caller_u ON caller_u.id = :callerUserId
            LEFT JOIN pod_members caller_pm ON caller_pm.pod_id = m.pod_id AND caller_pm.user_id = :callerUserId
            JOIN users peer_u ON peer_u.id = CASE WHEN m.sender_user_id = :callerUserId THEN m.recipient_user_id ELSE m.sender_user_id END
            LEFT JOIN pod_members peer_pm ON peer_pm.pod_id = m.pod_id AND peer_pm.user_id = peer_u.id
            LEFT JOIN pod_read_cursors my_rc
              ON my_rc.pod_id = m.pod_id
             AND my_rc.user_id = :callerUserId
             AND my_rc.peer_user_id = peer_u.id
            LEFT JOIN pod_read_cursors peer_rc
              ON peer_rc.pod_id = m.pod_id
             AND peer_rc.user_id = peer_u.id
             AND peer_rc.peer_user_id = :callerUserId
            WHERE m.id IN (:lastMsgIds)
            """.trimIndent()
        )
            .param("callerUserId", callerUserId)
            .param("lastMsgIds", lastMsgIds)
            .query { rs, _ ->
                val createdLdt = rs.getObject("created_at", LocalDateTime::class.java)
                RawDmSummaryRow(
                    msgId = rs.getLong("id"),
                    podInternalId = rs.getLong("pod_id"),
                    podPublicBytes = rs.getBytes("pod_public_id"),
                    senderUserId = rs.getLong("sender_user_id"),
                    senderAlias = rs.getString("sender_alias"),
                    senderColor = rs.getString("sender_color"),
                    recipientUserId = rs.getLong("recipient_user_id"),
                    recipientAlias = rs.getString("recipient_alias") ?: "",
                    msgType = rs.getInt("msg_type"),
                    body = rs.getString("body") ?: "",
                    isDeleted = rs.getInt("is_deleted") != 0,
                    createdAtIso = (createdLdt ?: LocalDateTime.now(ZoneOffset.UTC)).toInstant(ZoneOffset.UTC).toString(),
                    callerPublicBytes = rs.getBytes("caller_public_id"),
                    callerLiveAlias = rs.getString("caller_live_alias"),
                    peerUserId = rs.getLong("peer_uid"),
                    peerPublicBytes = rs.getBytes("peer_public_id"),
                    peerLiveAlias = rs.getString("peer_live_alias"),
                    peerLiveColor = rs.getString("peer_live_color"),
                    myLastReadId = rs.getLong("my_last_read_id"),
                    peerLastReadId = rs.getLong("peer_last_read_id")
                )
            }
            .list()

        val unreadPodIds = rows.filter { it.msgId > it.myLastReadId }.map { it.podInternalId }.distinct()
        val unreadByPodPeer = HashMap<Pair<Long, Long>, Int>()
        if (unreadPodIds.isNotEmpty()) {
            jdbcClient.sql(
                """
                SELECT m.pod_id,
                       m.sender_user_id AS peer_uid,
                       COUNT(*) AS unread_cnt
                FROM messages m FORCE INDEX (idx_messages_dm_low)
                LEFT JOIN pod_read_cursors my_rc
                  ON my_rc.pod_id = m.pod_id
                 AND my_rc.user_id = :callerUserId
                 AND my_rc.peer_user_id = m.dm_user_high_id
                WHERE m.pod_id IN (:unreadPodIds)
                  AND m.dm_user_low_id = :callerUserId
                  AND m.sender_user_id = m.dm_user_high_id
                  AND m.is_deleted = 0
                  AND m.id > COALESCE(my_rc.last_read_message_id, 0)
                GROUP BY m.pod_id, m.sender_user_id
                UNION ALL
                SELECT m.pod_id,
                       m.sender_user_id AS peer_uid,
                       COUNT(*) AS unread_cnt
                FROM messages m FORCE INDEX (idx_messages_dm_high)
                LEFT JOIN pod_read_cursors my_rc
                  ON my_rc.pod_id = m.pod_id
                 AND my_rc.user_id = :callerUserId
                 AND my_rc.peer_user_id = m.dm_user_low_id
                WHERE m.pod_id IN (:unreadPodIds)
                  AND m.dm_user_high_id = :callerUserId
                  AND m.dm_user_low_id > 0
                  AND m.sender_user_id = m.dm_user_low_id
                  AND m.is_deleted = 0
                  AND m.id > COALESCE(my_rc.last_read_message_id, 0)
                GROUP BY m.pod_id, m.sender_user_id
                """.trimIndent()
            )
                .param("callerUserId", callerUserId)
                .param("unreadPodIds", unreadPodIds)
                .query { rs ->
                    unreadByPodPeer[rs.getLong("pod_id") to rs.getLong("peer_uid")] = rs.getInt("unread_cnt")
                }
        }

        val blankActiveMsgIds = rows.filter { !it.isDeleted && it.body.isBlank() }.map { it.msgId }
        val voiceNoteMsgIds = HashSet<Long>()
        if (blankActiveMsgIds.isNotEmpty()) {
            jdbcClient.sql(
                """
                SELECT message_id, kind
                FROM message_attachments
                WHERE message_id IN (:msgIds)
                """.trimIndent()
            )
                .param("msgIds", blankActiveMsgIds)
                .query { rs ->
                    if (rs.getString("kind").equals("voice_note", ignoreCase = true)) {
                        voiceNoteMsgIds.add(rs.getLong("message_id"))
                    }
                }
        }

        val grouped = HashMap<Long, MutableList<DmSummaryDto>>()
        for (r in rows) {
            val podHex = UuidV7.toHex(r.podPublicBytes)
            val peerId = UuidV7.peerId(r.podPublicBytes, r.peerPublicBytes)
            val callerPeerId = UuidV7.peerId(r.podPublicBytes, r.callerPublicBytes)

            val peerAlias = r.peerLiveAlias
                ?: (if (r.senderUserId == r.peerUserId) r.senderAlias else r.recipientAlias).ifBlank { "Member" }
            val peerColor = r.peerLiveColor
                ?: (if (r.senderUserId == r.peerUserId) r.senderColor else "#334155")
            val callerAlias = r.callerLiveAlias
                ?: (if (r.senderUserId == callerUserId) r.senderAlias else r.recipientAlias)

            val lastBody = when {
                r.isDeleted -> "Message deleted"
                r.body.isNotBlank() -> r.body.take(240)
                r.msgType == 4 || r.msgId in voiceNoteMsgIds -> "Voice note"
                else -> "Sent an attachment"
            }

            grouped.computeIfAbsent(r.podInternalId) { mutableListOf() }.add(
                DmSummaryDto(
                    peerId = peerId,
                    peerAlias = peerAlias,
                    peerColor = peerColor,
                    online = isPeerOnline(podHex, peerId),
                    lastMessageId = r.msgId,
                    lastBody = lastBody,
                    lastSenderPeerId = if (r.senderUserId == callerUserId) callerPeerId else peerId,
                    lastSenderAlias = if (r.senderUserId == callerUserId) callerAlias else peerAlias,
                    lastCreatedAt = r.createdAtIso,
                    unreadCount = unreadByPodPeer[r.podInternalId to r.peerUserId] ?: 0,
                    peerLastReadMessageId = r.peerLastReadId
                )
            )
        }

        return grouped.mapValues { (_, list) -> list.sortedByDescending { it.lastMessageId } }
    }

    private fun setDbInVoice(podInternalId: Long, userId: Long, inVoice: Boolean) {
        try {
            jdbcClient.sql("UPDATE pod_members SET in_voice = :inVoice WHERE pod_id = :podId AND user_id = :userId")
                .param("inVoice", if (inVoice) 1 else 0)
                .param("podId", podInternalId)
                .param("userId", userId)
                .update()
        } catch (ex: Exception) {
            log.debug("in_voice DB update skipped: {}", ex.message)
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
