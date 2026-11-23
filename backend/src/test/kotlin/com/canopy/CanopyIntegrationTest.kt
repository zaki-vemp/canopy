package com.canopy

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.client.TestRestTemplate
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.core.io.ByteArrayResource
import org.springframework.http.HttpEntity
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.context.TestPropertySource
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.client.standard.StandardWebSocketClient
import org.springframework.web.socket.handler.TextWebSocketHandler
import java.net.URI
import java.util.concurrent.BlockingQueue
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(
    properties = [
        "spring.datasource.url=jdbc:mysql://127.0.0.1:3308/canopy_test?useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&allowMultiQueries=true&serverTimezone=UTC"
    ]
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class CanopyIntegrationTest {

    @LocalServerPort
    private var port: Int = 0

    @Autowired
    private lateinit var restTemplate: TestRestTemplate

    @Autowired
    private lateinit var jdbcClient: JdbcClient

    @Autowired
    private lateinit var objectMapper: ObjectMapper

    data class TestAccount(
        val email: String,
        val fullName: String,
        val gender: String,
        val nationalityCode: String,
        val token: String,
        val userPublicIdHex: String
    )

    private val accounts = mutableListOf<TestAccount>()
    private lateinit var pod1Id: String
    private lateinit var pod2Id: String
    private lateinit var pod1GeneralChannelId: String
    private lateinit var pod1LoungeVoiceChannelId: String

    @BeforeAll
    fun resetTestDatabase() {
        restTemplate.restTemplate.requestFactory = JdkClientHttpRequestFactory()
        val tablesToTruncate = listOf(
            "pod_proposal_votes",
            "pod_proposals",
            "pod_invites",
            "poll_votes",
            "polls",
            "message_attachments",
            "user_bookmarks",
            "message_reactions",
            "messages",
            "pod_opt_outs",
            "pod_members",
            "pod_channels",
            "pods",
            "user_interests",
            "users"
        )
        tablesToTruncate.forEach { tbl ->
            jdbcClient.sql("TRUNCATE TABLE $tbl").update()
        }
    }

    @Test
    @Order(1)
    fun `register 7 diverse users and verify private auth boundary`() {
        val specs = listOf(
            Triple("priya.anand@example.test", "Priya Anand", "female" to "IN"),
            Triple("lukas.weber@example.test", "Lukas Weber", "male" to "DE"),
            Triple("ren.takahashi@example.test", "Ren Takahashi", "non-binary" to "JP"),
            Triple("mateo.silva@example.test", "Mateo Silva", "male" to "BR"),
            Triple("adaeze.okafor@example.test", "Adaeze Okafor", "female" to "NG"),
            Triple("claire.tremblay@example.test", "Claire Tremblay", "genderqueer" to "CA"),
            Triple("soren.lindqvist@example.test", "Soren Lindqvist", "agender" to "SE")
        )

        for ((email, fullName, genderNat) in specs) {
            val (gender, nat) = genderNat
            val res = postJson(
                "/api/auth/register?tabOnly=true",
                null,
                mapOf(
                    "email" to email,
                    "password" to "SecretPass123!",
                    "fullName" to fullName,
                    "gender" to gender,
                    "nationalityCode" to nat
                )
            )
            assertEquals(HttpStatus.CREATED, res.statusCode, "Register failed: ${res.body}")
            val json = objectMapper.readTree(res.body!!)
            val token = json.path("token").asText()
            assertTrue(token.isNotBlank())
            val userNode = json.path("user")
            assertEquals(email, userNode.path("email").asText())
            assertEquals(fullName, userNode.path("fullName").asText())
            assertEquals(gender, userNode.path("gender").asText())
            assertEquals(nat, userNode.path("nationalityCode").asText())
            assertEquals("FREE", userNode.path("planTier").asText())

            // Verify GET /api/auth/me returns the private profile ONLY to the account owner
            val meRes = getJson("/api/auth/me", token)
            assertEquals(HttpStatus.OK, meRes.statusCode)
            val meUser = objectMapper.readTree(meRes.body!!).path("user")
            assertEquals(fullName, meUser.path("fullName").asText())
            assertEquals(gender, meUser.path("gender").asText())
            assertEquals(nat, meUser.path("nationalityCode").asText())
            assertEquals("FREE", meUser.path("planTier").asText())

            accounts.add(
                TestAccount(
                    email = email,
                    fullName = fullName,
                    gender = gender,
                    nationalityCode = nat,
                    token = token,
                    userPublicIdHex = userNode.path("userId").asText()
                )
            )
        }
        assertEquals(7, accounts.size)
    }

    @Test
    @Order(2)
    fun `blind pod matching groups first 6 users into pod 1 and spawns pod 2 for 7th user with zero PII leakage`() {
        // Save custom + seeded interests for user 0
        val putInterestsRes = exchangeJson(
            HttpMethod.PUT,
            "/api/me/interests",
            accounts[0].token,
            mapOf("interests" to listOf("gaming", "Synth & Modular"))
        )
        assertEquals(HttpStatus.OK, putInterestsRes.statusCode)
        val interestsArr = objectMapper.readTree(putInterestsRes.body!!).path("interests")
        assertTrue(interestsArr.any { it.path("slug").asText() == "gaming" && it.path("selected").asBoolean() })
        assertTrue(interestsArr.any { it.path("slug").asText() == "synth-modular" && it.path("selected").asBoolean() })

        // First 6 users match "gaming" -> must all land in the exact same pod
        val matchedPodIds = mutableListOf<String>()
        val assignedAliases = mutableSetOf<String>()
        for (i in 0 until 6) {
            val matchRes = postJson(
                "/api/pods/match",
                accounts[i].token,
                mapOf("interest" to "gaming", "matchAll" to false, "maxMembers" to 6)
            )
            assertEquals(HttpStatus.OK, matchRes.statusCode, "Match failed for user $i: ${matchRes.body}")
            assertZeroPiiLeak(matchRes.body!!)

            val matchedPod = objectMapper.readTree(matchRes.body!!).path("matched")[0]
            matchedPodIds.add(matchedPod.path("podId").asText())
            assignedAliases.add(matchedPod.path("myAlias").asText())
        }

        assertEquals(1, matchedPodIds.toSet().size, "First 6 users should share Pod 1")
        assertEquals(6, assignedAliases.size, "Every member in Pod 1 must receive a distinct room alias")
        pod1Id = matchedPodIds.first()

        // Verify Pod 1 now has memberCount == 6 and 5 default channels (3 TEXT + 2 VOICE)
        val podsRes = getJson("/api/pods", accounts[0].token)
        assertEquals(HttpStatus.OK, podsRes.statusCode)
        assertZeroPiiLeak(podsRes.body!!)

        val pod1Node = objectMapper.readTree(podsRes.body!!).path("pods")
            .first { it.path("podId").asText() == pod1Id }
        assertEquals(6, pod1Node.path("memberCount").asInt())
        assertEquals(6, pod1Node.path("members").size())

        val channels = pod1Node.path("channels")
        assertEquals(5, channels.size(), "Pod must auto-create 5 default Discord/Slack channels")
        val textChannels = channels.filter { it.path("kind").asText() == "TEXT" }
        val voiceChannels = channels.filter { it.path("kind").asText() == "VOICE" }
        assertEquals(3, textChannels.size)
        assertEquals(2, voiceChannels.size)

        pod1GeneralChannelId = textChannels.first { it.path("slug").asText() == "general" }
            .path("channelId").asText()
        pod1LoungeVoiceChannelId = voiceChannels.first { it.path("slug").asText() == "lounge-voice" }
            .path("channelId").asText()

        // Verify #general already has welcome + join SYSTEM messages with zero PII
        val generalMsgsRes = getJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages?beforeId=0&limit=40",
            accounts[0].token
        )
        assertEquals(HttpStatus.OK, generalMsgsRes.statusCode)
        assertZeroPiiLeak(generalMsgsRes.body!!)
        val generalMsgs = objectMapper.readTree(generalMsgsRes.body!!).path("messages")
        assertTrue(generalMsgs.size() >= 7, "Expected 1 welcome + 6 join system messages")

        // 7th user matches "gaming" -> Pod 1 is full (6/6), so Pod 2 must be spawned automatically!
        val seventhMatchRes = postJson(
            "/api/pods/match",
            accounts[6].token,
            mapOf("interest" to "gaming")
        )
        assertEquals(HttpStatus.OK, seventhMatchRes.statusCode)
        assertZeroPiiLeak(seventhMatchRes.body!!)
        val seventhPod = objectMapper.readTree(seventhMatchRes.body!!).path("matched")[0]
        pod2Id = seventhPod.path("podId").asText()
        assertNotEquals(pod1Id, pod2Id, "7th user must spawn a 2nd gaming pod")
        assertEquals(1, seventhPod.path("memberCount").asInt())
        assertEquals(25, seventhPod.path("maxMembers").asInt(), "Default pod maxMembers must be 25")
        assertEquals("DEMOCRATIC", seventhPod.path("governanceMode").asText())
        assertEquals(5, seventhPod.path("channels").size())
    }

    @Test
    @Order(3)
    fun `opt-out with rematch leaves pod 1 records pod_opt_outs and places user in pod 2`() {
        val mover = accounts[5]
        val beforePods = objectMapper.readTree(getJson("/api/pods", mover.token).body!!).path("pods")
        val pod1Before = beforePods.first { it.path("podId").asText() == pod1Id }
        val peerIdInPod1 = pod1Before.path("myPeerId").asText()

        // Leave Pod 1 with rematch = true -> Pod 1 now drops to 5/6 (open again!),
        // YET mover has opted out of Pod 1 so mover MUST land in Pod 2 (never Pod 1)!
        val leaveRes = postJson(
            "/api/pods/$pod1Id/leave",
            mover.token,
            mapOf("rematch" to true)
        )
        assertEquals(HttpStatus.OK, leaveRes.statusCode, "Leave+rematch failed: ${leaveRes.body}")
        assertZeroPiiLeak(leaveRes.body!!)

        val leaveJson = objectMapper.readTree(leaveRes.body!!)
        assertEquals(pod1Id, leaveJson.path("leftPodId").asText())
        val newPod = leaveJson.path("newPod")
        assertFalse(newPod.isNull)
        assertEquals(pod2Id, newPod.path("podId").asText(), "Rematch must skip opted-out Pod 1 and join Pod 2")
        assertEquals(2, newPod.path("memberCount").asInt())

        // PeerId is room-scoped SHA-256(podPublicId || userPublicId), so Pod 2 peerId must NOT link to Pod 1 peerId
        val peerIdInPod2 = newPod.path("myPeerId").asText()
        assertTrue(peerIdInPod2.startsWith("p_"))
        assertNotEquals(peerIdInPod1, peerIdInPod2, "peerId must be unlinkable across different pods")

        // Verify pod_opt_outs row exists in MySQL
        val optOutCount = jdbcClient.sql(
            """
            SELECT COUNT(*)
            FROM pod_opt_outs o
            JOIN users u ON u.id = o.user_id
            WHERE u.email = :email
            """.trimIndent()
        )
            .param("email", mover.email)
            .query { rs, _ -> rs.getLong(1) }
            .single()
        assertEquals(1L, optOutCount, "Expected pod_opt_outs row recorded")
    }

    @Test
    @Order(4)
    fun `rich chat supports threads reactions polls pins bookmarks attachments slash commands and FULLTEXT search`() {
        val u0 = accounts[0]
        val u1 = accounts[1]

        // 1. Post a top-level markdown message
        val rootMsgRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to "Anyone up for **Helldivers** co-op expedition tonight? ||Zero spoilers||")
        )
        assertEquals(HttpStatus.CREATED, rootMsgRes.statusCode)
        assertZeroPiiLeak(rootMsgRes.body!!)
        val rootMsg = objectMapper.readTree(rootMsgRes.body!!).path("message")
        val rootMsgId = rootMsg.path("id").asLong()
        assertEquals("TEXT", rootMsg.path("msgType").asText())
        assertEquals(0, rootMsg.path("replyCount").asInt())

        // 2. Post two Slack thread replies -> increments parent replyCount to 2
        val reply1Res = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u1.token,
            mapOf("body" to "Count me in for difficulty 9!", "parentMessageId" to rootMsgId)
        )
        assertEquals(HttpStatus.CREATED, reply1Res.statusCode)
        val reply2Res = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to "Dropping voice link in 5 mins", "parentMessageId" to rootMsgId)
        )
        assertEquals(HttpStatus.CREATED, reply2Res.statusCode)

        val threadRes = getJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/threads/$rootMsgId",
            u0.token
        )
        assertEquals(HttpStatus.OK, threadRes.statusCode)
        assertZeroPiiLeak(threadRes.body!!)
        val threadJson = objectMapper.readTree(threadRes.body!!)
        assertEquals(2, threadJson.path("parent").path("replyCount").asInt())
        assertEquals(2, threadJson.path("replies").size())

        // 3. Toggle emoji reactions
        val react1 = postJson("/api/messages/$rootMsgId/reactions", u0.token, mapOf("emoji" to "🔥"))
        assertEquals(HttpStatus.OK, react1.statusCode)
        val react2 = postJson("/api/messages/$rootMsgId/reactions", u1.token, mapOf("emoji" to "🔥"))
        assertEquals(HttpStatus.OK, react2.statusCode)
        val reactionsAfterAdd = objectMapper.readTree(react2.body!!).path("message").path("reactions")
        assertEquals(1, reactionsAfterAdd.size())
        assertEquals(2, reactionsAfterAdd[0].path("count").asInt())
        assertTrue(reactionsAfterAdd[0].path("meReacted").asBoolean())

        // Toggle off for u1 -> count drops back to 1 and meReacted becomes false for u1
        val reactToggleOff = postJson("/api/messages/$rootMsgId/reactions", u1.token, mapOf("emoji" to "🔥"))
        val reactionsAfterOff = objectMapper.readTree(reactToggleOff.body!!).path("message").path("reactions")
        assertEquals(1, reactionsAfterOff[0].path("count").asInt())
        assertFalse(reactionsAfterOff[0].path("meReacted").asBoolean())

        // 4. Slash command: /poll "Best co-op?" "Portal 2" "It Takes Two" + voting
        val pollCreateRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to """/poll "Best co-op?" "Portal 2" "It Takes Two"""")
        )
        assertEquals(HttpStatus.CREATED, pollCreateRes.statusCode, "Poll create failed: ${pollCreateRes.body}")
        assertZeroPiiLeak(pollCreateRes.body!!)
        val pollMsg = objectMapper.readTree(pollCreateRes.body!!).path("message")
        assertEquals("POLL", pollMsg.path("msgType").asText())
        val pollNode = pollMsg.path("poll")
        val pollId = pollNode.path("pollId").asLong()
        assertEquals("Best co-op?", pollNode.path("question").asText())
        assertEquals(2, pollNode.path("options").size())

        val vote0 = postJson("/api/polls/$pollId/vote", u0.token, mapOf("optionIndex" to 0))
        assertEquals(HttpStatus.OK, vote0.statusCode)
        val vote1 = postJson("/api/polls/$pollId/vote", u1.token, mapOf("optionIndex" to 1))
        assertEquals(HttpStatus.OK, vote1.statusCode)
        assertZeroPiiLeak(vote1.body!!)
        val votedOptions = objectMapper.readTree(vote1.body!!).path("message").path("poll").path("options")
        assertEquals(1, votedOptions[0].path("votes").asInt())
        assertEquals(1, votedOptions[1].path("votes").asInt())
        assertTrue(votedOptions[1].path("meVoted").asBoolean())

        // 5. Pins (via democratic majority in 5-member Pod 1) & Bookmarks
        val pinRes0 = postJson("/api/messages/$rootMsgId/pin", u0.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, pinRes0.statusCode)
        assertZeroPiiLeak(pinRes0.body!!)
        assertFalse(objectMapper.readTree(pinRes0.body!!).path("message").path("isPinned").asBoolean())
        assertEquals("OPEN", objectMapper.readTree(pinRes0.body!!).path("proposal").path("status").asText())

        assertEquals(HttpStatus.OK, postJson("/api/messages/$rootMsgId/pin", u1.token, emptyMap<String, Any>()).statusCode)
        val pinRes2 = postJson("/api/messages/$rootMsgId/pin", accounts[2].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, pinRes2.statusCode)
        assertTrue(objectMapper.readTree(pinRes2.body!!).path("message").path("isPinned").asBoolean())
        assertEquals("PASSED", objectMapper.readTree(pinRes2.body!!).path("proposal").path("status").asText())

        val pinsListRes = getJson("/api/pods/$pod1Id/pins", u1.token)
        assertEquals(HttpStatus.OK, pinsListRes.statusCode)
        assertZeroPiiLeak(pinsListRes.body!!)
        assertEquals(1, objectMapper.readTree(pinsListRes.body!!).path("messages").size())

        val bmRes = postJson("/api/messages/$rootMsgId/bookmark", u1.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, bmRes.statusCode)
        assertTrue(objectMapper.readTree(bmRes.body!!).path("bookmarked").asBoolean())

        val bmListRes = getJson("/api/bookmarks", u1.token)
        assertEquals(HttpStatus.OK, bmListRes.statusCode)
        assertZeroPiiLeak(bmListRes.body!!)
        val bmMessages = objectMapper.readTree(bmListRes.body!!).path("messages")
        assertEquals(1, bmMessages.size())
        assertTrue(bmMessages[0].path("isBookmarked").asBoolean())

        // 6. Voice note attachment upload + message linking -> msgType == "VOICE_NOTE"
        val multipartHeaders = HttpHeaders().apply {
            contentType = MediaType.MULTIPART_FORM_DATA
            setBearerAuth(u0.token)
        }
        val fileResource = object : ByteArrayResource(ByteArray(256) { 0x42 }) {
            override fun getFilename(): String = "intro-note.webm"
        }
        val form = LinkedMultiValueMap<String, Any>().apply {
            add("file", fileResource)
            add("kind", "voice_note")
            add("durationMs", "3400")
        }
        val uploadRes = restTemplate.exchange(
            "/api/pods/$pod1Id/attachments",
            HttpMethod.POST,
            HttpEntity(form, multipartHeaders),
            String::class.java
        )
        assertEquals(HttpStatus.CREATED, uploadRes.statusCode, "Upload failed: ${uploadRes.body}")
        val attId = objectMapper.readTree(uploadRes.body!!).path("id").asLong()

        val voiceMsgRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to "", "attachmentIds" to listOf(attId), "quoteMessageId" to rootMsgId)
        )
        assertEquals(HttpStatus.CREATED, voiceMsgRes.statusCode)
        assertZeroPiiLeak(voiceMsgRes.body!!)
        val voiceMsg = objectMapper.readTree(voiceMsgRes.body!!).path("message")
        assertEquals("VOICE_NOTE", voiceMsg.path("msgType").asText())
        assertEquals(1, voiceMsg.path("attachments").size())
        assertEquals(rootMsgId, voiceMsg.path("quoteMessage").path("id").asLong())

        // 7. FULLTEXT search (>=3 char token uses InnoDB FULLTEXT; <3 char fallback uses LIKE)
        val searchFtRes = getJson("/api/pods/$pod1Id/search?q=Helldivers", u1.token)
        assertEquals(HttpStatus.OK, searchFtRes.statusCode)
        assertZeroPiiLeak(searchFtRes.body!!)
        val searchFtMsgs = objectMapper.readTree(searchFtRes.body!!).path("messages")
        assertTrue(searchFtMsgs.any { it.path("id").asLong() == rootMsgId }, "FULLTEXT search should find rootMsgId")

        val searchShortRes = getJson("/api/pods/$pod1Id/search?q=co-op", u1.token)
        assertEquals(HttpStatus.OK, searchShortRes.statusCode)
        val searchShortMsgs = objectMapper.readTree(searchShortRes.body!!).path("messages")
        assertTrue(searchShortMsgs.size() > 0, "Short/hyphenated search fallback should find co-op messages")

        // 8. Edit & soft-delete author enforcement + custom channel + /icebreaker + /status
        val editOwn = exchangeJson(
            HttpMethod.PATCH,
            "/api/messages/$rootMsgId",
            u0.token,
            mapOf("body" to "Anyone up for **Helldivers** co-op expedition tonight? ||Zero spoilers|| (edited)")
        )
        assertEquals(HttpStatus.OK, editOwn.statusCode)
        assertFalse(objectMapper.readTree(editOwn.body!!).path("message").path("editedAt").isNull)

        val iceRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u1.token,
            mapOf("body" to "/icebreaker")
        )
        assertEquals(HttpStatus.CREATED, iceRes.statusCode)
        assertEquals("ICEBREAKER", objectMapper.readTree(iceRes.body!!).path("message").path("msgType").asText())

        val statusCmdRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to "/status Ready for co-op")
        )
        assertEquals(HttpStatus.OK, statusCmdRes.statusCode)
        assertEquals("status", objectMapper.readTree(statusCmdRes.body!!).path("commandHandled").asText())

        val patchStatusRes = exchangeJson(
            HttpMethod.PATCH,
            "/api/pods/$pod1Id/status",
            u1.token,
            mapOf("customStatus" to "Down for Portal 2")
        )
        assertEquals(HttpStatus.OK, patchStatusRes.statusCode)

        // Direct channel add in multi-member DEMOCRATIC pod is forbidden; ADD_CHANNEL proposal passes at 3/5 YES
        val directChForbidden = postJson(
            "/api/pods/$pod1Id/channels",
            u0.token,
            mapOf("label" to "builds-and-setups", "topic" to "Share loadouts", "kind" to "TEXT")
        )
        assertEquals(HttpStatus.FORBIDDEN, directChForbidden.statusCode)

        val addChPropRes = postJson(
            "/api/pods/$pod1Id/proposals",
            u0.token,
            mapOf("kind" to "ADD_CHANNEL", "label" to "builds-and-setups", "topic" to "Share loadouts", "channelKind" to "TEXT")
        )
        assertEquals(HttpStatus.CREATED, addChPropRes.statusCode)
        assertZeroPiiLeak(addChPropRes.body!!)
        val addChPropId = objectMapper.readTree(addChPropRes.body!!).path("proposal").path("id").asLong()
        assertEquals(HttpStatus.OK, postJson("/api/proposals/$addChPropId/vote", u1.token, mapOf("vote" to true)).statusCode)
        val addChPassRes = postJson("/api/proposals/$addChPropId/vote", accounts[2].token, mapOf("vote" to true))
        assertEquals(HttpStatus.OK, addChPassRes.statusCode)
        assertEquals("PASSED", objectMapper.readTree(addChPassRes.body!!).path("proposal").path("status").asText())
        assertTrue(
            objectMapper.readTree(addChPassRes.body!!).path("pod").path("channels")
                .any { it.path("slug").asText() == "builds-and-setups" }
        )
        val editForbidden = exchangeJson(
            HttpMethod.PATCH,
            "/api/messages/$rootMsgId",
            u1.token,
            mapOf("body" to "Not my message")
        )
        assertEquals(HttpStatus.FORBIDDEN, editForbidden.statusCode)

        val tempMsgRes = postJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
            u0.token,
            mapOf("body" to "/shrug temporary thought")
        )
        val tempMsgId = objectMapper.readTree(tempMsgRes.body!!).path("message").path("id").asLong()
        assertTrue(
            objectMapper.readTree(tempMsgRes.body!!).path("message").path("body").asText().contains("¯\\_(ツ)_/¯")
        )
        val delRes = exchangeJson(HttpMethod.DELETE, "/api/messages/$tempMsgId", u0.token, null)
        assertEquals(HttpStatus.OK, delRes.statusCode)
    }

    @Test
    @Order(5)
    fun `native WebSocket hub broadcasts messages voice roster and relays targeted WebRTC signals`() {
        val u0 = accounts[0]
        val u1 = accounts[1]
        val u2 = accounts[2] // 3rd member in Pod 1 — must NOT receive WebRTC signals targeted at u1!

        val client = StandardWebSocketClient()
        val q0: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val q1: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val q2: BlockingQueue<JsonNode> = LinkedBlockingQueue()

        val ws0 = connectPodWs(client, pod1Id, u0.token, q0)
        val ws1 = connectPodWs(client, pod1Id, u1.token, q1)
        val ws2 = connectPodWs(client, pod1Id, u2.token, q2)

        try {
            val snap0 = awaitFrame(q0) { it.path("type").asText() == "presence_snapshot" }
            val snap1 = awaitFrame(q1) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(q2) { it.path("type").asText() == "presence_snapshot" }

            assertZeroPiiLeak(objectMapper.writeValueAsString(snap0))
            val peer0 = snap0.path("selfPeerId").asText()
            val peer1 = snap1.path("selfPeerId").asText()
            assertTrue(peer0.startsWith("p_"))
            assertTrue(peer1.startsWith("p_"))
            assertNotEquals(peer0, peer1)

            // 1. Live message_created broadcast to connected WebSocket peers
            val sendRes = postJson(
                "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages",
                u0.token,
                mapOf("body" to "Live WebSocket broadcast check!")
            )
            assertEquals(HttpStatus.CREATED, sendRes.statusCode)

            val liveMsgOn1 = awaitFrame(q1) {
                it.path("type").asText() == "message_created" &&
                    it.path("message").path("body").asText() == "Live WebSocket broadcast check!"
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(liveMsgOn1))
            assertEquals(peer0, liveMsgOn1.path("message").path("senderPeerId").asText())

            // 1b. Private bookmark state on u0 must NEVER leak in WS broadcasts to u1, and untrusted Origin is rejected
            val liveMsgId = liveMsgOn1.path("message").path("id").asLong()
            assertEquals(HttpStatus.OK, postJson("/api/messages/$liveMsgId/bookmark", u0.token, emptyMap<String, Any>()).statusCode)
            assertEquals(HttpStatus.OK, postJson("/api/messages/$liveMsgId/pin", u0.token, emptyMap<String, Any>()).statusCode)
            assertEquals(HttpStatus.OK, postJson("/api/messages/$liveMsgId/pin", u1.token, emptyMap<String, Any>()).statusCode)
            assertEquals(HttpStatus.OK, postJson("/api/messages/$liveMsgId/pin", u2.token, emptyMap<String, Any>()).statusCode)
            val pinUpdateOn1 = awaitFrame(q1) {
                it.path("type").asText() == "pin_updated" && it.path("message").path("id").asLong() == liveMsgId
            }
            assertFalse(pinUpdateOn1.path("message").path("isBookmarked").asBoolean(), "Actor's private bookmark leaked over WS")

            val evilHeaders = org.springframework.web.socket.WebSocketHttpHeaders().apply { origin = "https://evil.example" }
            val evilAttempt = runCatching {
                client.execute(object : TextWebSocketHandler() {}, evilHeaders, URI.create("ws://127.0.0.1:$port/ws/pods/$pod1Id?token=${u0.token}"))
                    .get(5, TimeUnit.SECONDS)
            }
            assertTrue(evilAttempt.isFailure, "Untrusted cross-origin WebSocket handshake must be rejected")

            // 2. voice_join -> voice_roster_updated broadcast
            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf(
                            "type" to "voice_join",
                            "voiceChannelId" to pod1LoungeVoiceChannelId,
                            "muted" to false,
                            "deafened" to false
                        )
                    )
                )
            )

            val voiceUpdateOn1 = awaitFrame(q1) {
                it.path("type").asText() == "voice_roster_updated" &&
                    it.path("voiceRoster").path(pod1LoungeVoiceChannelId).size() == 1
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(voiceUpdateOn1))
            assertEquals(
                peer0,
                voiceUpdateOn1.path("voiceRoster").path(pod1LoungeVoiceChannelId)[0].path("peerId").asText()
            )

            // 3. Targeted webrtc_signal SDP offer from peer0 -> peer1 ONLY
            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf(
                            "type" to "webrtc_signal",
                            "targetPeerId" to peer1,
                            "voiceChannelId" to pod1LoungeVoiceChannelId,
                            "signal" to mapOf(
                                "type" to "offer",
                                "sdp" to "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\n"
                            )
                        )
                    )
                )
            )

            val signalOn1 = awaitFrame(q1) { it.path("type").asText() == "webrtc_signal" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(signalOn1))
            assertEquals(peer0, signalOn1.path("fromPeerId").asText())
            assertEquals(pod1LoungeVoiceChannelId, signalOn1.path("voiceChannelId").asText())
            assertEquals("offer", signalOn1.path("signal").path("type").asText())

            // Verify bystander peer2 in the same pod did NOT receive peer0 -> peer1's targeted signal
            val leakedToPeer2 = pollMatching(q2, 350L) { it.path("type").asText() == "webrtc_signal" }
            assertNull(leakedToPeer2, "webrtc_signal must only be delivered to targetPeerId")
        } finally {
            runCatching { ws0.close() }
            runCatching { ws1.close() }
            runCatching { ws2.close() }
        }
    }

    @Test
    @Order(6)
    fun `cursor pagination and concurrent 7-user blind pod matching stay lock-safe and exact`() {
        // 1. Cursor pagination check (limit=3 -> nextBeforeId -> older page)
        val page1Res = getJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages?beforeId=0&limit=3",
            accounts[0].token
        )
        assertEquals(HttpStatus.OK, page1Res.statusCode)
        val page1Json = objectMapper.readTree(page1Res.body!!)
        val page1Msgs = page1Json.path("messages")
        assertEquals(3, page1Msgs.size())
        val nextCursor = page1Json.path("nextBeforeId").asLong()
        assertTrue(nextCursor > 0L, "Expected positive nextBeforeId cursor")
        assertTrue(page1Msgs[0].path("id").asLong() < page1Msgs[2].path("id").asLong(), "Messages must be chronological")

        val page2Res = getJson(
            "/api/pods/$pod1Id/channels/$pod1GeneralChannelId/messages?beforeId=$nextCursor&limit=3",
            accounts[0].token
        )
        assertEquals(HttpStatus.OK, page2Res.statusCode)
        val page2Msgs = objectMapper.readTree(page2Res.body!!).path("messages")
        assertEquals(3, page2Msgs.size())
        assertTrue(page2Msgs[2].path("id").asLong() < page1Msgs[0].path("id").asLong(), "Page 2 must precede Page 1")

        // 2. Concurrent blind matching across all 7 accounts simultaneously for "chess"
        val pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()
        val barrier = java.util.concurrent.CyclicBarrier(accounts.size)
        val futures = accounts.map { acc ->
            pool.submit<ResponseEntity<String>> {
                barrier.await(5, TimeUnit.SECONDS)
                postJson("/api/pods/match", acc.token, mapOf("interest" to "chess", "maxMembers" to 6))
            }
        }
        val responses = futures.map { it.get(10, TimeUnit.SECONDS) }
        pool.close()

        val chessPodCounts = mutableMapOf<String, Int>()
        responses.forEach { r ->
            assertEquals(HttpStatus.OK, r.statusCode, "Concurrent match failed: ${r.body}")
            assertZeroPiiLeak(r.body!!)
            val pid = objectMapper.readTree(r.body!!).path("matched")[0].path("podId").asText()
            chessPodCounts[pid] = (chessPodCounts[pid] ?: 0) + 1
        }
        assertEquals(7, chessPodCounts.values.sum())
        assertEquals(2, chessPodCounts.size, "7 concurrent matches must pack into 2 chess pods (6 + 1)")
        assertTrue(chessPodCounts.values.all { it <= 6 }, "No pod may exceed maxMembers=6 under concurrency")
    }

    @Test
    @Order(7)
    fun `multi-pod capacity presets forceNewPod allowAdditional and native mobile originless WebSocket succeed`() {
        val u0 = accounts[0]

        // 1. Reject invalid maxMembers = 7 with 400 on both match and leave
        val badMatchRes = postJson(
            "/api/pods/match",
            u0.token,
            mapOf("interest" to "gaming", "maxMembers" to 7)
        )
        assertEquals(HttpStatus.BAD_REQUEST, badMatchRes.statusCode)
        assertTrue(badMatchRes.body!!.contains("maxMembers must be 4, 6, 10, 25, or 50"))

        val badLeaveRes = postJson(
            "/api/pods/$pod1Id/leave",
            u0.token,
            mapOf("rematch" to true, "maxMembers" to 7)
        )
        assertEquals(HttpStatus.BAD_REQUEST, badLeaveRes.statusCode)

        // 2. Cozy 4-seat pod (maxMembers = 4): first 4 users share Cozy pod 1; 5th user spawns Cozy pod 2
        val cozyPodIds = mutableListOf<String>()
        for (i in 0 until 4) {
            val res = postJson(
                "/api/pods/match",
                accounts[i].token,
                mapOf("interest" to "cozy-reading", "maxMembers" to 4)
            )
            assertEquals(HttpStatus.OK, res.statusCode, "Cozy match failed for user $i: ${res.body}")
            assertZeroPiiLeak(res.body!!)
            val pod = objectMapper.readTree(res.body!!).path("matched")[0]
            assertEquals(4, pod.path("maxMembers").asInt())
            cozyPodIds.add(pod.path("podId").asText())
        }
        assertEquals(1, cozyPodIds.toSet().size, "First 4 users must share the same 4-seat Cozy pod")

        val fifthCozyRes = postJson(
            "/api/pods/match",
            accounts[4].token,
            mapOf("interest" to "cozy-reading", "maxMembers" to 4)
        )
        assertEquals(HttpStatus.OK, fifthCozyRes.statusCode)
        val fifthCozyPod = objectMapper.readTree(fifthCozyRes.body!!).path("matched")[0]
        assertEquals(4, fifthCozyPod.path("maxMembers").asInt())
        assertEquals(1, fifthCozyPod.path("memberCount").asInt())
        assertNotEquals(cozyPodIds.first(), fifthCozyPod.path("podId").asText(), "5th user must spawn a 2nd Cozy pod")

        // 3. Lounge 10-seat pod (maxMembers = 10): all 7 users fit inside a single 10-seat Lounge pod
        val loungePodIds = mutableSetOf<String>()
        var lastLoungeMemberCount = 0
        for (acc in accounts) {
            val res = postJson(
                "/api/pods/match",
                acc.token,
                mapOf("interest" to "lounge-jazz", "maxMembers" to 10)
            )
            assertEquals(HttpStatus.OK, res.statusCode)
            assertZeroPiiLeak(res.body!!)
            val pod = objectMapper.readTree(res.body!!).path("matched")[0]
            assertEquals(10, pod.path("maxMembers").asInt())
            loungePodIds.add(pod.path("podId").asText())
            lastLoungeMemberCount = pod.path("memberCount").asInt()
        }
        assertEquals(1, loungePodIds.size, "All 7 users must fit in the single 10-seat Lounge pod")
        assertEquals(7, lastLoungeMemberCount)

        // 4. allowAdditional = true: u0 joins a 2nd gaming pod (pod2Id) simultaneously with distinct alias & unlinkable peerId
        val secondGamingRes = postJson(
            "/api/pods/match",
            u0.token,
            mapOf("interest" to "gaming", "allowAdditional" to true)
        )
        assertEquals(HttpStatus.OK, secondGamingRes.statusCode, "allowAdditional match failed: ${secondGamingRes.body}")
        assertZeroPiiLeak(secondGamingRes.body!!)
        val secondGamingJson = objectMapper.readTree(secondGamingRes.body!!)
        val secondGamingPod = secondGamingJson.path("matched")[0]
        assertEquals(pod2Id, secondGamingPod.path("podId").asText(), "u0 should join open Pod 2 rather than Pod 1")

        val u0GamingPods = secondGamingJson.path("pods").filter { it.path("interestSlug").asText() == "gaming" }
        assertEquals(2, u0GamingPods.size, "u0 must simultaneously belong to 2 gaming pods")
        val gPod1 = u0GamingPods.first { it.path("podId").asText() == pod1Id }
        val gPod2 = u0GamingPods.first { it.path("podId").asText() == pod2Id }
        assertNotEquals(
            gPod1.path("myAlias").asText(),
            gPod2.path("myAlias").asText(),
            "Multi-pod member must receive distinct anonymous aliases across pods"
        )
        assertNotEquals(
            gPod1.path("myPeerId").asText(),
            gPod2.path("myPeerId").asText(),
            "Multi-pod member must have unlinkable room-scoped peerIds across pods"
        )

        // 5. forceNewPod = true: spawns a brand-new 4-seat gaming pod on demand even while open gaming pods exist
        val forcedGamingRes = postJson(
            "/api/pods/match",
            u0.token,
            mapOf("interest" to "gaming", "maxMembers" to 4, "forceNewPod" to true)
        )
        assertEquals(HttpStatus.OK, forcedGamingRes.statusCode)
        assertZeroPiiLeak(forcedGamingRes.body!!)
        val forcedGamingPod = objectMapper.readTree(forcedGamingRes.body!!).path("matched")[0]
        val pod3Id = forcedGamingPod.path("podId").asText()
        assertNotEquals(pod1Id, pod3Id)
        assertNotEquals(pod2Id, pod3Id)
        assertEquals(4, forcedGamingPod.path("maxMembers").asInt())
        assertEquals(1, forcedGamingPod.path("memberCount").asInt())

        // Rematch pod3Id while still active in pod1Id and pod2Id -> replaces pod3Id with a 10-seat pod
        val multiRematchRes = postJson(
            "/api/pods/$pod3Id/leave",
            u0.token,
            mapOf("rematch" to true, "maxMembers" to 10, "forceNewPod" to true)
        )
        assertEquals(HttpStatus.OK, multiRematchRes.statusCode)
        assertZeroPiiLeak(multiRematchRes.body!!)
        val rematchedNode = objectMapper.readTree(multiRematchRes.body!!).path("newPod")
        assertEquals(10, rematchedNode.path("maxMembers").asInt())
        assertNotEquals(pod3Id, rematchedNode.path("podId").asText())

        // Enforce upper bound of 8 active pods per interest per user (u0 currently has 3 active gaming pods)
        for (extra in 4..8) {
            val extraRes = postJson(
                "/api/pods/match",
                u0.token,
                mapOf("interest" to "gaming", "maxMembers" to 4, "forceNewPod" to true)
            )
            assertEquals(HttpStatus.OK, extraRes.statusCode)
        }
        val ninthRes = postJson(
            "/api/pods/match",
            u0.token,
            mapOf("interest" to "gaming", "forceNewPod" to true)
        )
        assertEquals(HttpStatus.BAD_REQUEST, ninthRes.statusCode)
        assertTrue(ninthRes.body!!.contains("Maximum 8 active pods per interest reached"))

        // 6. Native mobile WebSocket handshake (NO Origin header at all) + Expo Web Origin handshake succeed
        val mobileInbox: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val textBuf = StringBuilder()
        val nativeWs = java.net.http.HttpClient.newHttpClient()
            .newWebSocketBuilder()
            .buildAsync(
                URI.create("ws://127.0.0.1:$port/ws/pods/$pod1Id?token=${u0.token}"),
                object : java.net.http.WebSocket.Listener {
                    override fun onOpen(webSocket: java.net.http.WebSocket) {
                        webSocket.request(1)
                    }

                    override fun onText(
                        webSocket: java.net.http.WebSocket,
                        data: CharSequence,
                        last: Boolean
                    ): java.util.concurrent.CompletionStage<*>? {
                        textBuf.append(data)
                        if (last) {
                            mobileInbox.offer(objectMapper.readTree(textBuf.toString()))
                            textBuf.setLength(0)
                        }
                        webSocket.request(1)
                        return null
                    }
                }
            )
            .get(5, TimeUnit.SECONDS)

        val expoClient = StandardWebSocketClient()
        val expoInbox: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val expoHeaders = org.springframework.web.socket.WebSocketHttpHeaders().apply {
            origin = "http://localhost:8081"
        }
        val expoWs = expoClient.execute(
            object : TextWebSocketHandler() {
                override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
                    expoInbox.offer(objectMapper.readTree(message.payload))
                }
            },
            expoHeaders,
            URI.create("ws://127.0.0.1:$port/ws/pods/$pod1Id?token=${u0.token}")
        ).get(5, TimeUnit.SECONDS)

        try {
            val mobileSnap = awaitFrame(mobileInbox) { it.path("type").asText() == "presence_snapshot" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(mobileSnap))
            assertEquals(pod1Id, mobileSnap.path("podId").asText())

            val expoSnap = awaitFrame(expoInbox) { it.path("type").asText() == "presence_snapshot" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(expoSnap))
            assertEquals(pod1Id, expoSnap.path("podId").asText())
        } finally {
            runCatching { nativeWs.sendClose(java.net.http.WebSocket.NORMAL_CLOSURE, "bye").get(2, TimeUnit.SECONDS) }
            runCatching { expoWs.close() }
        }
    }

    @Test
    @Order(8)
    fun `pod invite links support zero-PII public preview opt-out rejoin idempotency single-use exhaustion and revocation`() {
        val u0 = accounts[0]
        val u5OptedOut = accounts[5] // opted out of pod1Id in @Order(3)!
        val u6Outsider = accounts[6] // never joined pod1Id

        // 0. Non-member cannot create invites (403) & unauthenticated user cannot accept invites (401)
        val nonMemberCreate = postJson("/api/pods/$pod1Id/invites", u6Outsider.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.FORBIDDEN, nonMemberCreate.statusCode)

        val unauthAccept = postJson("/api/invites/k8m4p2x9q7w3/accept", null, emptyMap<String, Any>())
        assertEquals(HttpStatus.UNAUTHORIZED, unauthAccept.statusCode)

        assertEquals(
            HttpStatus.BAD_REQUEST,
            runCatching { com.canopy.pods.normalizeInviteCode("bad") }
                .exceptionOrNull()
                ?.let { (it as org.springframework.web.server.ResponseStatusException).statusCode }
        )
        assertEquals(
            "k8m4p2x9q7w3",
            com.canopy.pods.normalizeInviteCode("  https://canopy.app/invite/K8M4P2X9Q7W3?utm=share  ")
        )

        // 1. Create invite on pod1Id (currently 5/6 members) and verify reuse when regenerate=false
        val createRes = postJson("/api/pods/$pod1Id/invites", u0.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.CREATED, createRes.statusCode, "Create invite failed: ${createRes.body}")
        assertZeroPiiLeak(createRes.body!!)
        val createdInvite = objectMapper.readTree(createRes.body!!).path("invite")
        val code = createdInvite.path("code").asText()
        assertEquals(12, code.length)
        assertEquals(pod1Id, createdInvite.path("podId").asText())
        assertEquals("gaming", createdInvite.path("interestSlug").asText())
        assertEquals(5, createdInvite.path("memberCount").asInt())
        assertEquals(6, createdInvite.path("maxMembers").asInt())
        assertEquals(0, createdInvite.path("maxUses").asInt())
        assertEquals(0, createdInvite.path("usesCount").asInt())
        assertFalse(createdInvite.path("isExpired").asBoolean())
        assertFalse(createdInvite.path("isRevoked").asBoolean())
        assertFalse(createdInvite.path("isFull").asBoolean())
        assertTrue(createdInvite.path("canAccept").asBoolean())
        assertTrue(createdInvite.path("invitedByAlias").asText().isNotBlank())

        val reuseRes = postJson("/api/pods/$pod1Id/invites", u0.token, mapOf("regenerate" to false))
        assertEquals(HttpStatus.OK, reuseRes.statusCode)
        assertEquals(code, objectMapper.readTree(reuseRes.body!!).path("invite").path("code").asText())

        val listInvitesRes = getJson("/api/pods/$pod1Id/invites", u0.token)
        assertEquals(HttpStatus.OK, listInvitesRes.statusCode)
        assertZeroPiiLeak(listInvitesRes.body!!)
        assertEquals(1, objectMapper.readTree(listInvitesRes.body!!).path("invites").size())

        // 2. Public unauthenticated GET /api/invites/{code} succeeds with ZERO PII; unknown code returns 404
        val publicPreviewRes = getJson("/api/invites/$code", null)
        assertEquals(HttpStatus.OK, publicPreviewRes.statusCode)
        assertZeroPiiLeak(publicPreviewRes.body!!)
        val pubInvite = objectMapper.readTree(publicPreviewRes.body!!).path("invite")
        assertEquals(code, pubInvite.path("code").asText())
        assertEquals(pod1Id, pubInvite.path("podId").asText())
        assertTrue(pubInvite.path("canAccept").asBoolean())
        assertFalse(pubInvite.has("createdByUserId"))
        assertFalse(pubInvite.has("created_by_user_id"))

        assertEquals(HttpStatus.NOT_FOUND, getJson("/api/invites/unknowncode99", null).statusCode)

        // 3. Opted-out user (accounts[5]) accepts invite -> clears pod_opt_outs, rejoins pod1Id, broadcasts WS frames
        val wsClient = StandardWebSocketClient()
        val wsInbox: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val ws0 = connectPodWs(wsClient, pod1Id, u0.token, wsInbox)
        try {
            awaitFrame(wsInbox) { it.path("type").asText() == "presence_snapshot" }

            val acceptRes = postJson("/api/invites/${code.uppercase()}/accept", u5OptedOut.token, emptyMap<String, Any>())
            assertEquals(HttpStatus.OK, acceptRes.statusCode, "Accept invite failed: ${acceptRes.body}")
            assertZeroPiiLeak(acceptRes.body!!)
            val acceptJson = objectMapper.readTree(acceptRes.body!!)
            assertFalse(acceptJson.path("alreadyMember").asBoolean())
            val joinedPod = acceptJson.path("pod")
            assertEquals(pod1Id, joinedPod.path("podId").asText())
            assertEquals(6, joinedPod.path("memberCount").asInt())
            val rejoinedAlias = joinedPod.path("myAlias").asText()
            assertTrue(rejoinedAlias.isNotBlank())

            val joinedFrame = awaitFrame(wsInbox) { it.path("type").asText() == "member_joined" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(joinedFrame))
            assertEquals(rejoinedAlias, joinedFrame.path("member").path("alias").asText())

            val sysMsgFrame = awaitFrame(wsInbox) {
                it.path("type").asText() == "message_created" &&
                    it.path("message").path("body").asText() == "$rejoinedAlias joined via invite link"
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(sysMsgFrame))
        } finally {
            runCatching { ws0.close() }
        }

        val remainingOptOuts = jdbcClient.sql(
            """
            SELECT COUNT(*)
            FROM pod_opt_outs o
            JOIN users u ON u.id = o.user_id
            JOIN pods p ON p.id = o.pod_id
            WHERE u.email = :email AND p.public_id = UNHEX(:podHex)
            """.trimIndent()
        )
            .param("email", u5OptedOut.email)
            .param("podHex", pod1Id)
            .query { rs, _ -> rs.getLong(1) }
            .single()
        assertEquals(0L, remainingOptOuts, "Explicit invite accept must clear prior pod_opt_outs row")

        // 4. Idempotent re-accept by existing member (accounts[5]) returns alreadyMember = true without incrementing usesCount
        val reAcceptRes = postJson("/api/invites/$code/accept", u5OptedOut.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, reAcceptRes.statusCode)
        assertZeroPiiLeak(reAcceptRes.body!!)
        assertTrue(objectMapper.readTree(reAcceptRes.body!!).path("alreadyMember").asBoolean())

        // pod1Id is now 6/6 full -> public preview reports isFull=true/canAccept=false, and outsider gets 409 CONFLICT
        val fullPreview = objectMapper.readTree(getJson("/api/invites/$code", null).body!!).path("invite")
        assertEquals(1, fullPreview.path("usesCount").asInt())
        assertTrue(fullPreview.path("isFull").asBoolean())
        assertFalse(fullPreview.path("canAccept").asBoolean())

        val fullConflictRes = postJson("/api/invites/$code/accept", u6Outsider.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.CONFLICT, fullConflictRes.statusCode)

        // 5. Single-use (maxUses = 1) exhaustion -> 410 GONE for 3rd user, plus DELETE revocation -> 410 GONE
        val astroMatch = postJson("/api/pods/match", u0.token, mapOf("interest" to "astronomy"))
        assertEquals(HttpStatus.OK, astroMatch.statusCode)
        val astroPodId = objectMapper.readTree(astroMatch.body!!).path("matched")[0].path("podId").asText()

        val singleInviteRes = postJson(
            "/api/pods/$astroPodId/invites",
            u0.token,
            mapOf("maxUses" to 1, "expiresInHours" to 24, "regenerate" to true)
        )
        assertEquals(HttpStatus.CREATED, singleInviteRes.statusCode)
        val singleCode = objectMapper.readTree(singleInviteRes.body!!).path("invite").path("code").asText()

        val secondUserAccept = postJson("/api/invites/$singleCode/accept", accounts[1].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, secondUserAccept.statusCode)
        assertFalse(objectMapper.readTree(secondUserAccept.body!!).path("alreadyMember").asBoolean())

        // Idempotent re-accept still works for accounts[1] even after single-use invite hit usesCount == 1
        val secondUserReAccept = postJson("/api/invites/$singleCode/accept", accounts[1].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, secondUserReAccept.statusCode)
        assertTrue(objectMapper.readTree(secondUserReAccept.body!!).path("alreadyMember").asBoolean())

        // 3rd user (accounts[2]) gets 410 GONE because maxUses=1 is exhausted
        val thirdUserExhausted = postJson("/api/invites/$singleCode/accept", accounts[2].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.GONE, thirdUserExhausted.statusCode)
        assertTrue(thirdUserExhausted.body!!.contains("usage limit"))

        // Create unlimited never-expiring invite, revoke via DELETE, verify 410 GONE
        val revocableRes = postJson(
            "/api/pods/$astroPodId/invites",
            u0.token,
            mapOf("maxUses" to 0, "expiresInHours" to 0, "regenerate" to true)
        )
        assertEquals(HttpStatus.CREATED, revocableRes.statusCode)
        val revocableInvite = objectMapper.readTree(revocableRes.body!!).path("invite")
        assertTrue(revocableInvite.path("expiresAt").isNull)
        val revocableCode = revocableInvite.path("code").asText()

        val revokeDelRes = exchangeJson(
            HttpMethod.DELETE,
            "/api/pods/$astroPodId/invites/$revocableCode",
            u0.token,
            null
        )
        assertEquals(HttpStatus.OK, revokeDelRes.statusCode)
        assertTrue(objectMapper.readTree(revokeDelRes.body!!).path("ok").asBoolean())

        val revokedPreview = objectMapper.readTree(getJson("/api/invites/$revocableCode", null).body!!).path("invite")
        assertTrue(revokedPreview.path("isRevoked").asBoolean())
        assertFalse(revokedPreview.path("canAccept").asBoolean())

        val acceptRevokedRes = postJson("/api/invites/$revocableCode/accept", accounts[2].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.GONE, acceptRevokedRes.statusCode)
        assertTrue(acceptRevokedRes.body!!.contains("revoked"))

        // Verify expired invite -> isExpired=true/canAccept=false in preview and 410 GONE on accept
        val expInviteRes = postJson(
            "/api/pods/$astroPodId/invites",
            u0.token,
            mapOf("maxUses" to 0, "expiresInHours" to 1, "regenerate" to true)
        )
        val expCode = objectMapper.readTree(expInviteRes.body!!).path("invite").path("code").asText()
        jdbcClient.sql("UPDATE pod_invites SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE code = :code")
            .param("code", expCode)
            .update()

        val expPreview = objectMapper.readTree(getJson("/api/invites/$expCode", null).body!!).path("invite")
        assertTrue(expPreview.path("isExpired").asBoolean())
        assertFalse(expPreview.path("canAccept").asBoolean())

        val acceptExpiredRes = postJson("/api/invites/$expCode/accept", accounts[2].token, emptyMap<String, Any>())
        assertEquals(HttpStatus.GONE, acceptExpiredRes.statusCode)
        assertTrue(acceptExpiredRes.body!!.contains("expired"))
    }

    @Test
    @Order(9)
    fun `25-member default pods democratic YES-vs-NO governance engine and premium custom admin groups succeed with zero PII`() {
        val u0 = accounts[0]
        val u1 = accounts[1]
        val u2 = accounts[2]
        val u3 = accounts[3]
        val u4 = accounts[4]
        val u5 = accounts[5]

        // 1. Default matched pod has maxMembers == 25 and governanceMode == "DEMOCRATIC"
        val m0 = postJson("/api/pods/match", u0.token, mapOf("interest" to "tabletop-rpg"))
        assertEquals(HttpStatus.OK, m0.statusCode, "Match failed: ${m0.body}")
        assertZeroPiiLeak(m0.body!!)
        val rpgPod0 = objectMapper.readTree(m0.body!!).path("matched")[0]
        val rpgPodId = rpgPod0.path("podId").asText()
        assertEquals(25, rpgPod0.path("maxMembers").asInt(), "Default pod capacity must be 25")
        assertEquals("DEMOCRATIC", rpgPod0.path("governanceMode").asText())
        assertTrue(rpgPod0.path("allowRandomMatch").asBoolean())
        assertFalse(rpgPod0.path("isPublicized").asBoolean())
        assertEquals("MEMBER", rpgPod0.path("myRole").asText())

        val rpgGeneralChannelId = rpgPod0.path("channels")
            .first { it.path("slug").asText() == "general" }
            .path("channelId").asText()

        // 2. Join u1 and u2 into the same 25-member democratic pod -> 3 members total
        val m1 = postJson("/api/pods/match", u1.token, mapOf("interest" to "tabletop-rpg"))
        val m2 = postJson("/api/pods/match", u2.token, mapOf("interest" to "tabletop-rpg"))
        assertEquals(HttpStatus.OK, m1.statusCode)
        assertEquals(HttpStatus.OK, m2.statusCode)
        val rpgPod2 = objectMapper.readTree(m2.body!!).path("matched")[0]
        assertEquals(rpgPodId, rpgPod2.path("podId").asText())
        assertEquals(3, rpgPod2.path("memberCount").asInt())
        val u2PeerIdInRpg = rpgPod2.path("myPeerId").asText()
        val u2AliasInRpg = rpgPod2.path("myAlias").asText()

        val wsClient = StandardWebSocketClient()
        val q0: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val q1: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val ws0 = connectPodWs(wsClient, rpgPodId, u0.token, q0)
        val ws1 = connectPodWs(wsClient, rpgPodId, u1.token, q1)

        try {
            awaitFrame(q0) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(q1) { it.path("type").asText() == "presence_snapshot" }

            // 2a. ADD_CHANNEL proposal in 3-member pod:
            // u0 proposes #strategy-notes -> yesCount=1, noCount=0, status=OPEN, GOVERNANCE card in #general
            val propAddRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf(
                    "kind" to "ADD_CHANNEL",
                    "label" to "strategy-notes",
                    "topic" to "Campaign maps & lore",
                    "channelKind" to "TEXT",
                    "reason" to "Keep maps organized"
                )
            )
            assertEquals(HttpStatus.CREATED, propAddRes.statusCode, "Create proposal failed: ${propAddRes.body}")
            assertZeroPiiLeak(propAddRes.body!!)
            val propAddJson = objectMapper.readTree(propAddRes.body!!)
            val addPropId = propAddJson.path("proposal").path("id").asLong()
            assertEquals("OPEN", propAddJson.path("proposal").path("status").asText())
            assertEquals(1, propAddJson.path("proposal").path("yesCount").asInt())
            assertEquals(0, propAddJson.path("proposal").path("noCount").asInt())
            assertEquals(3, propAddJson.path("proposal").path("eligibleCount").asInt())
            assertTrue(propAddJson.path("proposal").path("myVote").asBoolean())
            assertEquals(1, propAddJson.path("pod").path("openProposalsCount").asInt())

            // Verify WS broadcast to u1 personalized myVote == null
            val propFrameOn1 = awaitFrame(q1) {
                it.path("type").asText() == "proposal_updated" &&
                    it.path("proposal").path("id").asLong() == addPropId
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(propFrameOn1))
            assertTrue(propFrameOn1.path("proposal").path("myVote").isNull)

            // Verify GOVERNANCE message in #general has hydrated proposal
            val generalMsgsRes = getJson(
                "/api/pods/$rpgPodId/channels/$rpgGeneralChannelId/messages?beforeId=0&limit=40",
                u1.token
            )
            assertEquals(HttpStatus.OK, generalMsgsRes.statusCode)
            assertZeroPiiLeak(generalMsgsRes.body!!)
            val govMsg = objectMapper.readTree(generalMsgsRes.body!!).path("messages")
                .first { it.path("msgType").asText() == "GOVERNANCE" && it.path("proposal").path("id").asLong() == addPropId }
            assertEquals("OPEN", govMsg.path("proposal").path("status").asText())
            assertTrue(govMsg.path("proposal").path("myVote").isNull)

            // u1 votes YES -> 2 Yes vs 0 No out of 3 (2 > 0 + 1 remaining!) -> IMMEDIATELY PASSES & creates #strategy-notes!
            val voteAddRes = postJson("/api/proposals/$addPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals(HttpStatus.OK, voteAddRes.statusCode, "Vote failed: ${voteAddRes.body}")
            assertZeroPiiLeak(voteAddRes.body!!)
            val voteAddJson = objectMapper.readTree(voteAddRes.body!!)
            assertEquals("PASSED", voteAddJson.path("proposal").path("status").asText())
            assertEquals(2, voteAddJson.path("proposal").path("yesCount").asInt())
            assertEquals(0, voteAddJson.path("proposal").path("noCount").asInt())
            assertEquals(0, voteAddJson.path("pod").path("openProposalsCount").asInt())
            assertTrue(
                voteAddJson.path("pod").path("channels").any { it.path("slug").asText() == "strategy-notes" },
                "Passed ADD_CHANNEL proposal must immediately create #strategy-notes"
            )

            val chCreatedOn0 = awaitFrame(q0) {
                it.path("type").asText() == "channel_created" &&
                    it.path("channel").path("slug").asText() == "strategy-notes"
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(chCreatedOn0))

            // 2b. Contested KICK_MEMBER proposal against u2:
            // u0 proposes KICK_MEMBER -> u2 votes NO (1 Yes vs 1 No, 1 remaining -> stays OPEN) -> u1 votes YES (2 > 1 -> PASSES & kicks u2!)
            val kickPropRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf(
                    "kind" to "KICK_MEMBER",
                    "targetPeerId" to u2PeerIdInRpg,
                    "reason" to "Disruptive soundboard spam"
                )
            )
            assertEquals(HttpStatus.CREATED, kickPropRes.statusCode, "Kick proposal failed: ${kickPropRes.body}")
            assertZeroPiiLeak(kickPropRes.body!!)
            val kickPropId = objectMapper.readTree(kickPropRes.body!!).path("proposal").path("id").asLong()
            assertEquals(u2AliasInRpg, objectMapper.readTree(kickPropRes.body!!).path("proposal").path("targetAlias").asText())

            // u2 votes NO -> 1 Yes vs 1 No (1 remaining) -> must stay OPEN
            val u2NoRes = postJson("/api/proposals/$kickPropId/vote", u2.token, mapOf("vote" to false))
            assertEquals(HttpStatus.OK, u2NoRes.statusCode)
            assertZeroPiiLeak(u2NoRes.body!!)
            val afterNo = objectMapper.readTree(u2NoRes.body!!).path("proposal")
            assertEquals("OPEN", afterNo.path("status").asText(), "1 Yes vs 1 No with 1 remaining must stay OPEN")
            assertEquals(1, afterNo.path("yesCount").asInt())
            assertEquals(1, afterNo.path("noCount").asInt())
            assertFalse(afterNo.path("myVote").asBoolean())

            // u1 votes YES -> 2 Yes vs 1 No (0 remaining, 2 > 1!) -> IMMEDIATELY PASSES & evicts u2!
            val u1YesKickRes = postJson("/api/proposals/$kickPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals(HttpStatus.OK, u1YesKickRes.statusCode)
            assertZeroPiiLeak(u1YesKickRes.body!!)
            val afterKick = objectMapper.readTree(u1YesKickRes.body!!)
            assertEquals("PASSED", afterKick.path("proposal").path("status").asText())
            assertEquals(2, afterKick.path("proposal").path("yesCount").asInt())
            assertEquals(1, afterKick.path("proposal").path("noCount").asInt())
            assertEquals(2, afterKick.path("pod").path("memberCount").asInt(), "u2 must be removed from pod_members")

            val kickedFrame = awaitFrame(q0) {
                it.path("type").asText() == "member_kicked" &&
                    it.path("peerId").asText() == u2PeerIdInRpg
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(kickedFrame))

            // Verify kicked u2 is blocked from re-matching into rpgPodId (spawns a separate pod instead!)
            val u2Rematch = postJson("/api/pods/match", u2.token, mapOf("interest" to "tabletop-rpg"))
            assertEquals(HttpStatus.OK, u2Rematch.statusCode)
            val u2NewRpgPodId = objectMapper.readTree(u2Rematch.body!!).path("matched")[0].path("podId").asText()
            assertNotEquals(rpgPodId, u2NewRpgPodId, "Kicked member must never re-match into the pod that kicked them")

            // 2c. Tie/majority NO rejection (1 Yes vs 1 No in 2-member pod -> 1 <= 1 REJECTED) + expired 1 Yes vs 0 No -> PASSED
            val capPropRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf("kind" to "CHANGE_CAPACITY", "maxMembers" to 50)
            )
            assertEquals(HttpStatus.CREATED, capPropRes.statusCode)
            val capPropId = objectMapper.readTree(capPropRes.body!!).path("proposal").path("id").asLong()
            val capRejectRes = postJson("/api/proposals/$capPropId/vote", u1.token, mapOf("vote" to false))
            assertEquals(HttpStatus.OK, capRejectRes.statusCode)
            assertEquals("REJECTED", objectMapper.readTree(capRejectRes.body!!).path("proposal").path("status").asText())
            assertEquals(25, objectMapper.readTree(capRejectRes.body!!).path("pod").path("maxMembers").asInt())

            val renamePropRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf("kind" to "RENAME_POD", "label" to "Arcane Guild", "topic" to "Weekly D&D campaigns", "expiresInMinutes" to 5)
            )
            assertEquals(HttpStatus.CREATED, renamePropRes.statusCode)
            val renamePropId = objectMapper.readTree(renamePropRes.body!!).path("proposal").path("id").asLong()
            assertEquals("OPEN", objectMapper.readTree(renamePropRes.body!!).path("proposal").path("status").asText())

            // Backdate expires_at -> 1 Yes vs 0 No at expiry resolves to PASSED (`yesCount > noCount`)!
            jdbcClient.sql("UPDATE pod_proposals SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE) WHERE id = :id")
                .param("id", renamePropId)
                .update()
            val resolveExpiredRes = postJson("/api/proposals/$renamePropId/resolve", u0.token, emptyMap<String, Any>())
            assertEquals(HttpStatus.OK, resolveExpiredRes.statusCode)
            assertZeroPiiLeak(resolveExpiredRes.body!!)
            assertEquals("PASSED", objectMapper.readTree(resolveExpiredRes.body!!).path("proposal").path("status").asText())
            assertEquals("Arcane Guild", objectMapper.readTree(resolveExpiredRes.body!!).path("pod").path("title").asText())

            val listPropsRes = getJson("/api/pods/$rpgPodId/proposals", u0.token)
            assertEquals(HttpStatus.OK, listPropsRes.statusCode)
            assertZeroPiiLeak(listPropsRes.body!!)
            assertTrue(objectMapper.readTree(listPropsRes.body!!).path("proposals").size() >= 4)

            // 2d. Verify UPDATE_TOPIC, TOGGLE_LOCK, and REMOVE_CHANNEL proposals (plus #general protection)
            val strategyChId = objectMapper.readTree(resolveExpiredRes.body!!).path("pod").path("channels")
                .first { it.path("slug").asText() == "strategy-notes" }
                .path("channelId").asText()

            assertEquals(
                HttpStatus.BAD_REQUEST,
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "REMOVE_CHANNEL", "channelId" to rpgGeneralChannelId)).statusCode,
                "#general must be protected from removal"
            )

            val topicPropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "UPDATE_TOPIC", "channelId" to strategyChId, "topic" to "Boss mechanics")).body!!
            ).path("proposal").path("id").asLong()
            val topicVoteRes = postJson("/api/proposals/$topicPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals("PASSED", objectMapper.readTree(topicVoteRes.body!!).path("proposal").path("status").asText())
            assertEquals(
                "Boss mechanics",
                objectMapper.readTree(topicVoteRes.body!!).path("pod").path("channels")
                    .first { it.path("channelId").asText() == strategyChId }.path("topic").asText()
            )

            val lockPropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "TOGGLE_LOCK", "locked" to true)).body!!
            ).path("proposal").path("id").asLong()
            val lockVoteRes = postJson("/api/proposals/$lockPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals("PASSED", objectMapper.readTree(lockVoteRes.body!!).path("proposal").path("status").asText())
            assertFalse(objectMapper.readTree(lockVoteRes.body!!).path("pod").path("isOpen").asBoolean())

            val rmChPropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "REMOVE_CHANNEL", "channelId" to strategyChId)).body!!
            ).path("proposal").path("id").asLong()
            val rmChVoteRes = postJson("/api/proposals/$rmChPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals("PASSED", objectMapper.readTree(rmChVoteRes.body!!).path("proposal").path("status").asText())
            assertFalse(
                objectMapper.readTree(rmChVoteRes.body!!).path("pod").path("channels")
                    .any { it.path("channelId").asText() == strategyChId }
            )
            val chDeletedFrame = awaitFrame(q0) {
                it.path("type").asText() == "channel_deleted" && it.path("channelId").asText() == strategyChId
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(chDeletedFrame))
        } finally {
            runCatching { ws0.close() }
            runCatching { ws1.close() }
        }

        // 3. Premium Custom Owned Admin Pods & Publicized Directory
        // 3a. Free user calling POST /api/pods/custom gets 403
        val freeCustomForbidden = postJson(
            "/api/pods/custom",
            u3.token,
            mapOf(
                "title" to "Tactical Co-op Raiders",
                "code" to "tactical-raiders",
                "interest" to "tactical-raids",
                "description" to "Nightly Helldivers runs",
                "maxMembers" to 25,
                "isPublicized" to true
            )
        )
        assertEquals(HttpStatus.FORBIDDEN, freeCustomForbidden.statusCode)

        // 3b. Upgrade u3 to PREMIUM via POST /api/auth/plan
        val upgradeRes = postJson("/api/auth/plan", u3.token, mapOf("planTier" to "PREMIUM"))
        assertEquals(HttpStatus.OK, upgradeRes.statusCode)
        assertEquals("PREMIUM", objectMapper.readTree(upgradeRes.body!!).path("user").path("planTier").asText())

        // 3c. Create publicized custom ADMIN pod
        val createCustomRes = postJson(
            "/api/pods/custom",
            u3.token,
            mapOf(
                "title" to "Tactical Co-op Raiders",
                "code" to "tactical-raiders",
                "interest" to "tactical-raids",
                "description" to "Nightly Helldivers runs",
                "maxMembers" to 25,
                "isPublicized" to true
            )
        )
        assertEquals(HttpStatus.CREATED, createCustomRes.statusCode, "Create custom pod failed: ${createCustomRes.body}")
        assertZeroPiiLeak(createCustomRes.body!!)
        val customPod = objectMapper.readTree(createCustomRes.body!!).path("pod")
        val customPodId = customPod.path("podId").asText()
        val u3OwnerAlias = customPod.path("myAlias").asText()
        assertEquals("Tactical Co-op Raiders", customPod.path("title").asText())
        assertEquals("tactical-raiders", customPod.path("code").asText())
        assertEquals("ADMIN", customPod.path("governanceMode").asText())
        assertTrue(customPod.path("isPublicized").asBoolean())
        assertFalse(customPod.path("allowRandomMatch").asBoolean())
        assertEquals("OWNER", customPod.path("myRole").asText())
        assertEquals(25, customPod.path("maxMembers").asInt())

        // Random match for "tactical-raids" must NEVER land in someone's custom ADMIN pod!
        val randomRaidMatch = postJson("/api/pods/match", u4.token, mapOf("interest" to "tactical-raids"))
        assertEquals(HttpStatus.OK, randomRaidMatch.statusCode)
        val randomRaidPod = objectMapper.readTree(randomRaidMatch.body!!).path("matched")[0]
        assertNotEquals(customPodId, randomRaidPod.path("podId").asText(), "Random matching must exclude ADMIN pods")
        assertEquals("DEMOCRATIC", randomRaidPod.path("governanceMode").asText())

        // 3d. Appears in GET /api/pods/publicized with zero PII
        val pubDirRes = getJson("/api/pods/publicized?interest=tactical-raids", u4.token)
        assertEquals(HttpStatus.OK, pubDirRes.statusCode)
        assertZeroPiiLeak(pubDirRes.body!!)
        val groups = objectMapper.readTree(pubDirRes.body!!).path("groups")
        assertEquals(1, groups.size())
        assertEquals(customPodId, groups[0].path("podId").asText())
        assertEquals("Tactical Co-op Raiders", groups[0].path("title").asText())
        assertEquals(u3OwnerAlias, groups[0].path("founderAlias").asText())
        assertFalse(groups[0].path("alreadyMember").asBoolean())

        // 3e. u4 and u5 join via POST /api/pods/{podId}/join
        val joinU4 = postJson("/api/pods/$customPodId/join", u4.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, joinU4.statusCode, "Publicized join failed: ${joinU4.body}")
        assertZeroPiiLeak(joinU4.body!!)
        val u4JoinedPod = objectMapper.readTree(joinU4.body!!).path("pod")
        assertEquals("MEMBER", u4JoinedPod.path("myRole").asText())
        assertEquals(2, u4JoinedPod.path("memberCount").asInt())
        val u4PeerId = u4JoinedPod.path("myPeerId").asText()

        val joinU5 = postJson("/api/pods/$customPodId/join", u5.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, joinU5.statusCode)
        val u5PeerId = objectMapper.readTree(joinU5.body!!).path("pod").path("myPeerId").asText()

        // Plain MEMBER (u4) cannot update settings or kick (403)
        assertEquals(
            HttpStatus.FORBIDDEN,
            exchangeJson(HttpMethod.PATCH, "/api/pods/$customPodId/settings", u4.token, mapOf("title" to "Hijack")).statusCode
        )
        assertEquals(
            HttpStatus.FORBIDDEN,
            postJson("/api/pods/$customPodId/admin/kick", u4.token, mapOf("targetPeerId" to u5PeerId)).statusCode
        )

        // 3f. Owner promotes u4 to ADMIN, updates settings, adds & deletes channel, and kicks u5 instantly without a vote!
        val promoteRes = postJson(
            "/api/pods/$customPodId/admin/role",
            u3.token,
            mapOf("targetPeerId" to u4PeerId, "role" to "ADMIN")
        )
        assertEquals(HttpStatus.OK, promoteRes.statusCode)
        assertZeroPiiLeak(promoteRes.body!!)
        val promotedMember = objectMapper.readTree(promoteRes.body!!).path("pod").path("members")
            .first { it.path("peerId").asText() == u4PeerId }
        assertEquals("ADMIN", promotedMember.path("role").asText())

        val settingsRes = exchangeJson(
            HttpMethod.PATCH,
            "/api/pods/$customPodId/settings",
            u3.token,
            mapOf("title" to "Tactical Co-op Raiders HQ", "maxMembers" to 50, "isPublicized" to true)
        )
        assertEquals(HttpStatus.OK, settingsRes.statusCode)
        assertZeroPiiLeak(settingsRes.body!!)
        assertEquals("Tactical Co-op Raiders HQ", objectMapper.readTree(settingsRes.body!!).path("pod").path("title").asText())
        assertEquals(50, objectMapper.readTree(settingsRes.body!!).path("pod").path("maxMembers").asInt())

        val instantChRes = postJson(
            "/api/pods/$customPodId/channels",
            u4.token, // newly promoted ADMIN can also manage channels!
            mapOf("label" to "raid-briefings", "topic" to "Loadouts", "kind" to "TEXT")
        )
        assertEquals(HttpStatus.CREATED, instantChRes.statusCode)
        val raidBriefingsChId = objectMapper.readTree(instantChRes.body!!).path("channel").path("channelId").asText()

        val delChRes = exchangeJson(
            HttpMethod.DELETE,
            "/api/pods/$customPodId/channels/$raidBriefingsChId",
            u3.token,
            null
        )
        assertEquals(HttpStatus.OK, delChRes.statusCode)
        assertFalse(
            objectMapper.readTree(delChRes.body!!).path("pod").path("channels")
                .any { it.path("channelId").asText() == raidBriefingsChId }
        )

        val adminKickRes = postJson(
            "/api/pods/$customPodId/admin/kick",
            u3.token,
            mapOf("targetPeerId" to u5PeerId)
        )
        assertEquals(HttpStatus.OK, adminKickRes.statusCode)
        assertZeroPiiLeak(adminKickRes.body!!)
        assertEquals(2, objectMapper.readTree(adminKickRes.body!!).path("pod").path("memberCount").asInt())

        // Kicked u5 cannot rejoin via publicized join (403)
        val kickedRejoinRes = postJson("/api/pods/$customPodId/join", u5.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.FORBIDDEN, kickedRejoinRes.statusCode)
    }

    private fun connectPodWs(
        client: StandardWebSocketClient,
        podId: String,
        jwt: String,
        inbox: BlockingQueue<JsonNode>
    ): WebSocketSession {
        val uri = URI.create("ws://127.0.0.1:$port/ws/pods/$podId?token=$jwt")
        val handler = object : TextWebSocketHandler() {
            override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
                inbox.offer(objectMapper.readTree(message.payload))
            }
        }
        return client.execute(handler, null, uri).get(5, TimeUnit.SECONDS)
    }

    private fun awaitFrame(inbox: BlockingQueue<JsonNode>, predicate: (JsonNode) -> Boolean): JsonNode {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline) {
            val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(10L)
            val next = inbox.poll(remaining, TimeUnit.MILLISECONDS) ?: break
            if (predicate(next)) return next
        }
        throw AssertionError("Timed out waiting for expected WebSocket frame")
    }

    private fun pollMatching(
        inbox: BlockingQueue<JsonNode>,
        waitMs: Long,
        predicate: (JsonNode) -> Boolean
    ): JsonNode? {
        val deadline = System.currentTimeMillis() + waitMs
        while (System.currentTimeMillis() < deadline) {
            val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(5L)
            val next = inbox.poll(remaining, TimeUnit.MILLISECONDS) ?: return null
            if (predicate(next)) return next
        }
        return null
    }

    /**
     * Asserts that NO private identity fields or values (fullName, email, gender, nationalityCode,
     * userId, userPublicId) appear anywhere in a pod/chat/WebSocket JSON payload.
     */
    private fun assertZeroPiiLeak(rawJson: String) {
        val forbiddenKeys = setOf("userId", "userPublicId", "email", "fullName", "gender", "nationalityCode")
        val nationalities = accounts.map { it.nationalityCode }.toSet()

        for (acc in accounts) {
            assertFalse(rawJson.contains(acc.fullName, ignoreCase = true), "Leaked fullName '${acc.fullName}' in: $rawJson")
            assertFalse(rawJson.contains(acc.email, ignoreCase = true), "Leaked email '${acc.email}' in: $rawJson")
            assertFalse(rawJson.contains(acc.gender, ignoreCase = true), "Leaked gender '${acc.gender}' in: $rawJson")
            assertFalse(
                rawJson.contains(acc.userPublicIdHex, ignoreCase = true),
                "Leaked userPublicId '${acc.userPublicIdHex}' in: $rawJson"
            )
        }

        val root = objectMapper.readTree(rawJson)
        fun walk(node: JsonNode) {
            when {
                node.isObject -> {
                    node.fieldNames().forEachRemaining { fieldName ->
                        assertFalse(fieldName in forbiddenKeys, "Forbidden PII key '$fieldName' present in payload: $rawJson")
                        walk(node.get(fieldName))
                    }
                }
                node.isArray -> node.forEach { walk(it) }
                node.isTextual -> {
                    val v = node.asText()
                    assertFalse(v in nationalities, "Leaked nationalityCode '$v' in payload: $rawJson")
                }
            }
        }
        walk(root)
    }

    private fun getJson(path: String, bearerToken: String?): ResponseEntity<String> {
        return exchangeJson(HttpMethod.GET, path, bearerToken, null)
    }

    private fun postJson(path: String, bearerToken: String?, body: Any?): ResponseEntity<String> {
        return exchangeJson(HttpMethod.POST, path, bearerToken, body)
    }

    private fun exchangeJson(
        method: HttpMethod,
        path: String,
        bearerToken: String?,
        body: Any?
    ): ResponseEntity<String> {
        val headers = HttpHeaders().apply {
            contentType = MediaType.APPLICATION_JSON
            if (!bearerToken.isNullOrBlank()) {
                setBearerAuth(bearerToken)
            }
        }
        val jsonBody = if (body != null) objectMapper.writeValueAsString(body) else null
        return restTemplate.exchange(path, method, HttpEntity(jsonBody, headers), String::class.java)
    }
}
