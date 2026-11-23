package com.canopy.ws

import com.canopy.security.JwtService
import com.canopy.util.UuidV7
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpStatus
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.http.server.ServletServerHttpRequest
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry
import org.springframework.web.socket.server.HandshakeInterceptor
import org.springframework.web.util.UriComponentsBuilder

@Configuration
@EnableWebSocket
class WebSocketConfig(
    private val podWebSocketHandler: PodWebSocketHandler,
    private val jwtService: JwtService,
    private val jdbcClient: JdbcClient,
    @Value("\${canopy.cors-origins:http://localhost:3001,http://127.0.0.1:3001,http://localhost:3000,http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006}")
    corsOrigins: String
) : WebSocketConfigurer {
    private val allowedOrigins: Array<String> = corsOrigins.split(",")
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .toTypedArray()

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        registry.addHandler(podWebSocketHandler, "/ws/pods/{podId}")
            .addInterceptors(podHandshakeInterceptor())
            .setAllowedOrigins(*allowedOrigins)
    }

    private fun podHandshakeInterceptor(): HandshakeInterceptor = object : HandshakeInterceptor {
        override fun beforeHandshake(
            request: ServerHttpRequest,
            response: ServerHttpResponse,
            wsHandler: WebSocketHandler,
            attributes: MutableMap<String, Any>
        ): Boolean {
            val token = extractToken(request)
            if (token.isNullOrBlank()) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED)
                return false
            }

            val principal = try {
                jwtService.parseToken(token)
            } catch (_: Exception) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED)
                return false
            }

            val podIdRaw = extractPodIdFromPath(request.uri.path)
            if (podIdRaw.isNullOrBlank()) {
                response.setStatusCode(HttpStatus.BAD_REQUEST)
                return false
            }

            val podPublicIdBytes = try {
                UuidV7.fromHex(podIdRaw)
            } catch (_: IllegalArgumentException) {
                response.setStatusCode(HttpStatus.BAD_REQUEST)
                return false
            }

            val membership = jdbcClient.sql(
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
                .param("userId", principal.userId())
                .param("podPublicId", podPublicIdBytes)
                .query { rs, _ ->
                    MembershipHandshakeRow(
                        podInternalId = rs.getLong("pod_id"),
                        podPublicIdBytes = rs.getBytes("pod_public_id"),
                        alias = rs.getString("alias"),
                        color = rs.getString("alias_color")
                    )
                }
                .optional()
                .orElse(null)

            if (membership == null) {
                response.setStatusCode(HttpStatus.FORBIDDEN)
                return false
            }

            val podPublicIdHex = UuidV7.toHex(membership.podPublicIdBytes)
            val selfPeerId = UuidV7.peerId(membership.podPublicIdBytes, principal.userPublicId())

            attributes["authPrincipal"] = principal
            attributes["podInternalId"] = membership.podInternalId
            attributes["podPublicIdHex"] = podPublicIdHex
            attributes["selfPeerId"] = selfPeerId
            attributes["alias"] = membership.alias
            attributes["color"] = membership.color
            return true
        }

        override fun afterHandshake(
            request: ServerHttpRequest,
            response: ServerHttpResponse,
            wsHandler: WebSocketHandler,
            exception: Exception?
        ) = Unit
    }

    private data class MembershipHandshakeRow(
        val podInternalId: Long,
        val podPublicIdBytes: ByteArray,
        val alias: String,
        val color: String
    )

    private fun extractPodIdFromPath(path: String?): String? {
        if (path.isNullOrBlank()) return null
        val prefix = "/ws/pods/"
        val idx = path.indexOf(prefix)
        if (idx < 0) return null
        return path.substring(idx + prefix.length).trim('/').takeIf { it.isNotEmpty() }
    }

    private fun extractToken(request: ServerHttpRequest): String? {
        val queryToken = UriComponentsBuilder.fromUri(request.uri).build()
            .queryParams.getFirst("token")
            ?.trim()
        if (!queryToken.isNullOrEmpty()) {
            return queryToken
        }

        val authHeader = request.headers.getFirst("Authorization")?.trim()
        if (!authHeader.isNullOrEmpty() && authHeader.startsWith("Bearer ", ignoreCase = true)) {
            val bearer = authHeader.substring(7).trim()
            if (bearer.isNotEmpty()) return bearer
        }

        if (request is ServletServerHttpRequest) {
            val cookieVal = request.servletRequest.cookies
                ?.firstOrNull { it.name == "canopy_jwt" }
                ?.value
                ?.trim()
            if (!cookieVal.isNullOrEmpty()) return cookieVal
        }

        val rawCookieHeader = request.headers.getFirst("Cookie")
        if (!rawCookieHeader.isNullOrBlank()) {
            rawCookieHeader.split(';').forEach { part ->
                val trimmed = part.trim()
                if (trimmed.startsWith("canopy_jwt=")) {
                    val v = trimmed.removePrefix("canopy_jwt=").trim()
                    if (v.isNotEmpty()) return v
                }
            }
        }
        return null
    }
}
