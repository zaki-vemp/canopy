package com.canopy.ws

import com.fasterxml.jackson.databind.ObjectMapper
import com.canopy.security.AuthPrincipal
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.TextWebSocketHandler

@Component
class PodWebSocketHandler(
    private val hub: PodRealtimeHub,
    private val objectMapper: ObjectMapper
) : TextWebSocketHandler() {

    private val log = LoggerFactory.getLogger(PodWebSocketHandler::class.java)

    override fun afterConnectionEstablished(session: WebSocketSession) {
        val conn = toConnectedSession(session)
        if (conn == null) {
            session.close(CloseStatus.POLICY_VIOLATION)
            return
        }
        hub.registerSession(conn)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val conn = toConnectedSession(session) ?: return
        val payload = message.payload
        if (payload.isBlank() || payload.length > 65_536) return
        val frame = try {
            objectMapper.readValue(payload, WsClientFrame::class.java)
        } catch (ex: Exception) {
            log.debug("Ignoring malformed WS frame on {}: {}", session.id, ex.message)
            return
        }
        hub.handleClientFrame(conn, frame)
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        hub.unregisterSession(session)
    }

    override fun handleTransportError(session: WebSocketSession, exception: Throwable) {
        hub.unregisterSession(session)
    }

    private fun toConnectedSession(session: WebSocketSession): PodRealtimeHub.ConnectedSession? {
        val attrs = session.attributes
        val principal = attrs["authPrincipal"] as? AuthPrincipal ?: return null
        val podInternalId = (attrs["podInternalId"] as? Number)?.toLong() ?: return null
        val podPublicIdHex = attrs["podPublicIdHex"] as? String ?: return null
        val selfPeerId = attrs["selfPeerId"] as? String ?: return null
        val alias = attrs["alias"] as? String ?: return null
        val color = attrs["color"] as? String ?: return null

        return PodRealtimeHub.ConnectedSession(
            session = session,
            userId = principal.userId(),
            podInternalId = podInternalId,
            podIdHex = podPublicIdHex,
            peerId = selfPeerId,
            alias = alias,
            color = color
        )
    }
}
