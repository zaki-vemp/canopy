package com.canopy

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
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

    @BeforeAll
    fun resetTestDatabase() {
        restTemplate.restTemplate.requestFactory = JdkClientHttpRequestFactory()
        val tablesToTruncate = listOf(
            "pod_read_cursors",
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
    fun `blind pod matching groups first 6 users into channel-free pod 1 and spawns pod 2 for 7th user with zero PII`() {
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

        val podsRes = getJson("/api/pods", accounts[0].token)
        assertEquals(HttpStatus.OK, podsRes.statusCode)
        assertZeroPiiLeak(podsRes.body!!)

        val pod1Node = objectMapper.readTree(podsRes.body!!).path("pods")
            .first { it.path("podId").asText() == pod1Id }
        assertEquals(6, pod1Node.path("memberCount").asInt())
        assertFalse(pod1Node.path("isOpen").asBoolean(), "6/6 full pod must have isOpen=false")
        assertFalse(pod1Node.has("channels"), "PodDetailDto must NOT contain Slack-style channels")
        assertTrue(pod1Node.has("dmConversations"), "PodDetailDto must contain dmConversations")
        assertEquals(0, pod1Node.path("dmConversations").size())
        assertEquals(6, pod1Node.path("members").size())
        assertTrue(pod1Node.path("members").all { it.has("inVoice") && !it.has("voiceChannelId") })

        // Verify Pod Group Chat already has welcome + 6 join SYSTEM messages with zero PII
        val groupMsgsRes = getJson(
            "/api/pods/$pod1Id/messages?beforeId=0&limit=40",
            accounts[0].token
        )
        assertEquals(HttpStatus.OK, groupMsgsRes.statusCode)
        assertZeroPiiLeak(groupMsgsRes.body!!)
        val groupMsgs = objectMapper.readTree(groupMsgsRes.body!!).path("messages")
        assertTrue(groupMsgs.size() >= 7, "Expected 1 welcome + 6 join system messages in Group Chat")
        assertTrue(groupMsgs.all { it.path("recipientPeerId").isNull && it.path("recipientAlias").isNull })

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
        assertTrue(seventhPod.path("isOpen").asBoolean())
    }

    @Test
    @Order(3)
    fun `opt-out with rematch leaves pod 1 records pod_opt_outs and places user in pod 2`() {
        val mover = accounts[5]
        val beforePods = objectMapper.readTree(getJson("/api/pods", mover.token).body!!).path("pods")
        val pod1Before = beforePods.first { it.path("podId").asText() == pod1Id }
        val peerIdInPod1 = pod1Before.path("myPeerId").asText()

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

        val peerIdInPod2 = newPod.path("myPeerId").asText()
        assertTrue(peerIdInPod2.startsWith("p_"))
        assertNotEquals(peerIdInPod1, peerIdInPod2, "peerId must be unlinkable across different pods")

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
    fun `pod group chat supports inline quotes reactions polls pins bookmarks voice notes slash commands and FULLTEXT search`() {
        val u0 = accounts[0]
        val u1 = accounts[1]

        // 1. Post a Group Chat markdown message
        val rootMsgRes = postJson(
            "/api/pods/$pod1Id/messages",
            u0.token,
            mapOf("body" to "Anyone up for **Helldivers** co-op expedition tonight? ||Zero spoilers||")
        )
        assertEquals(HttpStatus.CREATED, rootMsgRes.statusCode)
        assertZeroPiiLeak(rootMsgRes.body!!)
        val rootMsg = objectMapper.readTree(rootMsgRes.body!!).path("message")
        val rootMsgId = rootMsg.path("id").asLong()
        assertEquals("TEXT", rootMsg.path("msgType").asText())
        assertTrue(rootMsg.path("recipientPeerId").isNull)
        assertTrue(rootMsg.path("recipientAlias").isNull)
        assertFalse(rootMsg.has("channelId"))
        assertFalse(rootMsg.has("parentMessageId"))
        assertFalse(rootMsg.has("replyCount"))

        // 2. Inline quoted reply in Group Chat
        val quoteReplyRes = postJson(
            "/api/pods/$pod1Id/messages",
            u1.token,
            mapOf("body" to "Count me in for difficulty 9!", "quoteMessageId" to rootMsgId)
        )
        assertEquals(HttpStatus.CREATED, quoteReplyRes.statusCode)
        assertZeroPiiLeak(quoteReplyRes.body!!)
        val quoteReplyMsg = objectMapper.readTree(quoteReplyRes.body!!).path("message")
        assertEquals(rootMsgId, quoteReplyMsg.path("quoteMessage").path("id").asLong())

        // 3. Toggle emoji reactions
        val react1 = postJson("/api/messages/$rootMsgId/reactions", u0.token, mapOf("emoji" to "🔥"))
        assertEquals(HttpStatus.OK, react1.statusCode)
        val react2 = postJson("/api/messages/$rootMsgId/reactions", u1.token, mapOf("emoji" to "🔥"))
        assertEquals(HttpStatus.OK, react2.statusCode)
        val reactionsAfterAdd = objectMapper.readTree(react2.body!!).path("message").path("reactions")
        assertEquals(1, reactionsAfterAdd.size())
        assertEquals(2, reactionsAfterAdd[0].path("count").asInt())
        assertTrue(reactionsAfterAdd[0].path("meReacted").asBoolean())

        val reactToggleOff = postJson("/api/messages/$rootMsgId/reactions", u1.token, mapOf("emoji" to "🔥"))
        val reactionsAfterOff = objectMapper.readTree(reactToggleOff.body!!).path("message").path("reactions")
        assertEquals(1, reactionsAfterOff[0].path("count").asInt())
        assertFalse(reactionsAfterOff[0].path("meReacted").asBoolean())

        // 4. Slash command: /poll "Best co-op?" "Portal 2" "It Takes Two" + voting
        val pollCreateRes = postJson(
            "/api/pods/$pod1Id/messages",
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

        // 6. Voice note attachment upload: restricted to uploader while unattached (message_id == 0), then accessible to pod once sent in Group Chat
        val attId = uploadAttachment(pod1Id, u0.token, "intro-note.webm", "voice_note", 3400)
        assertEquals(HttpStatus.OK, downloadAttachment(attId, u0.token).statusCode, "Uploader can access unattached upload")
        assertEquals(
            HttpStatus.FORBIDDEN,
            downloadAttachment(attId, u1.token).statusCode,
            "Other pod member cannot download unattached upload before send"
        )

        val voiceMsgRes = postJson(
            "/api/pods/$pod1Id/messages",
            u0.token,
            mapOf("body" to "", "attachmentIds" to listOf(attId), "quoteMessageId" to rootMsgId)
        )
        assertEquals(HttpStatus.CREATED, voiceMsgRes.statusCode)
        assertZeroPiiLeak(voiceMsgRes.body!!)
        val voiceMsg = objectMapper.readTree(voiceMsgRes.body!!).path("message")
        assertEquals("VOICE_NOTE", voiceMsg.path("msgType").asText())
        assertEquals(1, voiceMsg.path("attachments").size())
        assertEquals(rootMsgId, voiceMsg.path("quoteMessage").path("id").asLong())
        assertEquals(HttpStatus.OK, downloadAttachment(attId, u1.token).statusCode, "Pod member can download Group Chat attachment")

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

        // 8. Edit & soft-delete author enforcement + /icebreaker + /status + /shrug
        val editOwn = exchangeJson(
            HttpMethod.PATCH,
            "/api/messages/$rootMsgId",
            u0.token,
            mapOf("body" to "Anyone up for **Helldivers** co-op expedition tonight? ||Zero spoilers|| (edited)")
        )
        assertEquals(HttpStatus.OK, editOwn.statusCode)
        assertFalse(objectMapper.readTree(editOwn.body!!).path("message").path("editedAt").isNull)

        val editForbidden = exchangeJson(
            HttpMethod.PATCH,
            "/api/messages/$rootMsgId",
            u1.token,
            mapOf("body" to "Not my message")
        )
        assertEquals(HttpStatus.FORBIDDEN, editForbidden.statusCode)

        val iceRes = postJson("/api/pods/$pod1Id/messages", u1.token, mapOf("body" to "/icebreaker"))
        assertEquals(HttpStatus.CREATED, iceRes.statusCode)
        assertEquals("ICEBREAKER", objectMapper.readTree(iceRes.body!!).path("message").path("msgType").asText())

        val statusCmdRes = postJson("/api/pods/$pod1Id/messages", u0.token, mapOf("body" to "/status Ready for co-op"))
        assertEquals(HttpStatus.OK, statusCmdRes.statusCode)
        assertEquals("status", objectMapper.readTree(statusCmdRes.body!!).path("commandHandled").asText())

        val patchStatusRes = exchangeJson(
            HttpMethod.PATCH,
            "/api/pods/$pod1Id/status",
            u1.token,
            mapOf("customStatus" to "Down for Portal 2")
        )
        assertEquals(HttpStatus.OK, patchStatusRes.statusCode)

        val tempMsgRes = postJson("/api/pods/$pod1Id/messages", u0.token, mapOf("body" to "/shrug temporary thought"))
        val tempMsgId = objectMapper.readTree(tempMsgRes.body!!).path("message").path("id").asLong()
        assertTrue(
            objectMapper.readTree(tempMsgRes.body!!).path("message").path("body").asText().contains("¯\\_(ツ)_/¯")
        )
        val delRes = exchangeJson(HttpMethod.DELETE, "/api/messages/$tempMsgId", u0.token, null)
        assertEquals(HttpStatus.OK, delRes.statusCode)
    }

    @Test
    @Order(5)
    fun `1-to-1 private member DMs enforce strict REST WebSocket typing search and attachment confidentiality`() {
        val uA = accounts[0]
        val uB = accounts[1]
        val uC = accounts[2] // Bystander in the SAME Pod 1!

        val podA = objectMapper.readTree(getJson("/api/pods", uA.token).body!!).path("pods")
            .first { it.path("podId").asText() == pod1Id }
        val podB = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == pod1Id }
        val peerA = podA.path("myPeerId").asText()
        val aliasA = podA.path("myAlias").asText()
        val peerB = podB.path("myPeerId").asText()
        val aliasB = podB.path("myAlias").asText()

        // 0. Self-DM returns 400 BAD_REQUEST; unknown peerId returns 404 NOT_FOUND
        assertEquals(
            HttpStatus.BAD_REQUEST,
            postJson("/api/pods/$pod1Id/dms/$peerA/messages", uA.token, mapOf("body" to "Self DM")).statusCode
        )
        assertEquals(
            HttpStatus.NOT_FOUND,
            postJson("/api/pods/$pod1Id/dms/p_000000000000/messages", uA.token, mapOf("body" to "Ghost DM")).statusCode
        )

        val client = StandardWebSocketClient()
        val qA: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val qB: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val qC: BlockingQueue<JsonNode> = LinkedBlockingQueue()

        val wsA = connectPodWs(client, pod1Id, uA.token, qA)
        val wsB = connectPodWs(client, pod1Id, uB.token, qB)
        val wsC = connectPodWs(client, pod1Id, uC.token, qC)

        try {
            awaitFrame(qA) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(qB) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(qC) { it.path("type").asText() == "presence_snapshot" }
            qA.clear()
            qB.clear()
            qC.clear()

            // 1. 1:1 DM private typing indicator reaches User B (and User A) and NEVER reaches User C!
            wsA.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "typing", "targetPeerId" to peerB, "isTyping" to true)
                    )
                )
            )
            val dmTypingOnB = awaitFrame(qB) {
                it.path("type").asText() == "typing_update" && it.path("targetPeerId").asText() == peerB
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmTypingOnB))
            assertEquals(peerA, dmTypingOnB.path("fromPeerId").asText())
            assertEquals(listOf(aliasA), dmTypingOnB.path("typingAliases").map { it.asText() })
            awaitFrame(qA) { it.path("type").asText() == "typing_update" && it.path("targetPeerId").asText() == peerB }

            val leakedTypingToC = pollMatching(qC, 300L) { true }
            assertNull(leakedTypingToC, "Bystander User C must receive ZERO frames for User A -> User B DM typing")

            // Group Chat typing (targetPeerId = null) DOES broadcast to User C
            wsB.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "typing", "targetPeerId" to null, "isTyping" to true)
                    )
                )
            )
            val groupTypingOnC = awaitFrame(qC) {
                it.path("type").asText() == "typing_update" && it.path("targetPeerId").isNull
            }
            assertTrue(groupTypingOnC.path("fromPeerId").isNull)
            assertTrue(groupTypingOnC.path("typingAliases").any { it.asText() == aliasB })
            qA.clear()
            qB.clear()
            qC.clear()

            // 2. User A DMs User B -> User B receives message_created over WS while User C receives ZERO frames!
            val dm1Res = postJson(
                "/api/pods/$pod1Id/dms/$peerB/messages",
                uA.token,
                mapOf("body" to "SecretVaultCoord7749 — down for co-op at 22:00?")
            )
            assertEquals(HttpStatus.CREATED, dm1Res.statusCode, "Send DM failed: ${dm1Res.body}")
            assertZeroPiiLeak(dm1Res.body!!)
            val dm1Msg = objectMapper.readTree(dm1Res.body!!).path("message")
            val dm1Id = dm1Msg.path("id").asLong()
            assertEquals(peerA, dm1Msg.path("senderPeerId").asText())
            assertEquals(aliasA, dm1Msg.path("senderAlias").asText())
            assertEquals(peerB, dm1Msg.path("recipientPeerId").asText())
            assertEquals(aliasB, dm1Msg.path("recipientAlias").asText())

            // Note: clearDmTyping also fires a typing_update(emptyList) ONLY to A & B, then message_created ONLY to A & B!
            val dmCreatedOnB = awaitFrame(qB) {
                it.path("type").asText() == "message_created" && it.path("message").path("id").asLong() == dm1Id
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmCreatedOnB))
            assertEquals(peerB, dmCreatedOnB.path("message").path("recipientPeerId").asText())

            val anyFrameOnC = pollMatching(qC, 400L) { true }
            assertNull(anyFrameOnC, "Bystander User C connected to same pod WS must receive ZERO frames for A <-> B DM!")

            // 3. User B replies in 1:1 DM quoting dm1Id -> quoteMessage populated; quoting dm1Id in Group Chat is stripped!
            val dm2Res = postJson(
                "/api/pods/$pod1Id/dms/$peerA/messages",
                uB.token,
                mapOf("body" to "Locked in for 22:00!", "quoteMessageId" to dm1Id)
            )
            assertEquals(HttpStatus.CREATED, dm2Res.statusCode)
            assertZeroPiiLeak(dm2Res.body!!)
            val dm2Msg = objectMapper.readTree(dm2Res.body!!).path("message")
            val dm2Id = dm2Msg.path("id").asLong()
            assertEquals(dm1Id, dm2Msg.path("quoteMessage").path("id").asLong())
            awaitFrame(qA) { it.path("type").asText() == "message_created" && it.path("message").path("id").asLong() == dm2Id }
            assertNull(pollMatching(qC, 300L) { true }, "User C must receive ZERO frames on User B -> User A DM reply")

            val crossQuoteAttempt = postJson(
                "/api/pods/$pod1Id/messages",
                uB.token,
                mapOf("body" to "Public chat check", "quoteMessageId" to dm1Id)
            )
            assertEquals(HttpStatus.CREATED, crossQuoteAttempt.statusCode)
            assertTrue(
                objectMapper.readTree(crossQuoteAttempt.body!!).path("message").path("quoteMessage").isNull,
                "Group Chat message must NEVER hydrate a private 1:1 DM quote!"
            )
            qC.clear()

            // 4. Private DM attachment: A & B get 200 OK, User C gets 403 FORBIDDEN!
            val dmAttId = uploadAttachment(pod1Id, uA.token, "secret-map.png", "image", 0)
            val dmAttMsgRes = postJson(
                "/api/pods/$pod1Id/dms/$peerB/messages",
                uA.token,
                mapOf("body" to "", "attachmentIds" to listOf(dmAttId))
            )
            assertEquals(HttpStatus.CREATED, dmAttMsgRes.statusCode)
            val dmAttMsgId = objectMapper.readTree(dmAttMsgRes.body!!).path("message").path("id").asLong()

            assertEquals(HttpStatus.OK, downloadAttachment(dmAttId, uA.token).statusCode)
            assertEquals(HttpStatus.OK, downloadAttachment(dmAttId, uB.token).statusCode)
            assertEquals(
                HttpStatus.FORBIDDEN,
                downloadAttachment(dmAttId, uC.token).statusCode,
                "Bystander User C must get 403 FORBIDDEN on private DM attachment download!"
            )

            // 5. User C gets 403 on react / edit / delete / pin / bookmark of User A <-> User B's DM!
            assertEquals(
                HttpStatus.FORBIDDEN,
                postJson("/api/messages/$dm1Id/reactions", uC.token, mapOf("emoji" to "👀")).statusCode
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                exchangeJson(HttpMethod.PATCH, "/api/messages/$dm1Id", uC.token, mapOf("body" to "Hack")).statusCode
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                exchangeJson(HttpMethod.DELETE, "/api/messages/$dm1Id", uC.token, null).statusCode
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                postJson("/api/messages/$dm1Id/pin", uC.token, emptyMap<String, Any>()).statusCode
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                postJson("/api/messages/$dm1Id/bookmark", uC.token, emptyMap<String, Any>()).statusCode
            )

            // 6. Pod search returns A <-> B's DM ONLY to A & B, and NEVER to User C!
            val searchA = objectMapper.readTree(getJson("/api/pods/$pod1Id/search?q=SecretVaultCoord7749", uA.token).body!!).path("messages")
            val searchB = objectMapper.readTree(getJson("/api/pods/$pod1Id/search?q=SecretVaultCoord7749", uB.token).body!!).path("messages")
            val searchC = objectMapper.readTree(getJson("/api/pods/$pod1Id/search?q=SecretVaultCoord7749", uC.token).body!!).path("messages")
            assertEquals(1, searchA.size())
            assertEquals(1, searchB.size())
            assertEquals(0, searchC.size(), "Search for User C must NEVER return User A <-> User B's private DM!")

            // Also verify <3-char LIKE fallback search respects DM privacy!
            val shortDmRes = postJson("/api/pods/$pod1Id/dms/$peerB/messages", uA.token, mapOf("body" to "gg9x"))
            assertEquals(HttpStatus.CREATED, shortDmRes.statusCode)
            val shortSearchC = objectMapper.readTree(getJson("/api/pods/$pod1Id/search?q=9x", uC.token).body!!).path("messages")
            assertEquals(0, shortSearchC.size(), "LIKE search fallback for User C must NEVER return private DMs!")

            // 7. DM reactions, edits, pins, bookmarks, and deletes stay strictly scoped to {uA, uB}
            qC.clear()
            assertEquals(HttpStatus.OK, postJson("/api/messages/$dm1Id/reactions", uB.token, mapOf("emoji" to "🤝")).statusCode)
            assertEquals(
                HttpStatus.OK,
                exchangeJson(HttpMethod.PATCH, "/api/messages/$dm1Id", uA.token, mapOf("body" to "SecretVaultCoord7749 — 22:15 sharp!")).statusCode
            )
            assertEquals(HttpStatus.OK, postJson("/api/messages/$dm1Id/pin", uA.token, emptyMap<String, Any>()).statusCode)
            assertEquals(HttpStatus.OK, postJson("/api/messages/$dm1Id/bookmark", uB.token, emptyMap<String, Any>()).statusCode)

            // Group Chat pins endpoint must NOT expose pinned 1:1 DMs!
            val podPinsForC = objectMapper.readTree(getJson("/api/pods/$pod1Id/pins", uC.token).body!!).path("messages")
            assertFalse(podPinsForC.any { it.path("id").asLong() == dm1Id }, "GET /api/pods/{podId}/pins must only return Group Chat pins")

            // User B's bookmarks include dm1Id; User C's bookmarks do NOT
            val bBookmarks = objectMapper.readTree(getJson("/api/bookmarks", uB.token).body!!).path("messages")
            assertTrue(bBookmarks.any { it.path("id").asLong() == dm1Id })

            // Verify DM conversation summary when last message is attachment-only ("Sent an attachment") vs deleted ("Message deleted")
            val shortDmId = objectMapper.readTree(shortDmRes.body!!).path("message").path("id").asLong()
            assertEquals(HttpStatus.OK, exchangeJson(HttpMethod.DELETE, "/api/messages/$shortDmId", uA.token, null).statusCode)

            assertNull(
                pollMatching(qC, 350L) { true },
                "User C must receive ZERO WS frames across DM reaction, edit, pin, and delete!"
            )

            // Check dmConversations on GET /api/pods/{podId}/dms and GET /api/pods for A, B, and C!
            val dmsForA = objectMapper.readTree(getJson("/api/pods/$pod1Id/dms", uA.token).body!!)
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmsForA))
            assertEquals(1, dmsForA.path("conversations").size())
            val summaryOnA = dmsForA.path("conversations")[0]
            assertEquals(peerB, summaryOnA.path("peerId").asText())
            assertEquals(aliasB, summaryOnA.path("peerAlias").asText())
            assertTrue(summaryOnA.path("online").asBoolean())
            assertEquals(shortDmId, summaryOnA.path("lastMessageId").asLong())
            assertEquals("Message deleted", summaryOnA.path("lastBody").asText())
            assertEquals(peerA, summaryOnA.path("lastSenderPeerId").asText())

            // Also verify attachment summary ("Sent an attachment") when an attachment DM is the latest message
            val dmAtt2Id = uploadAttachment(pod1Id, uB.token, "build-notes.pdf", "file", 0)
            val dmAtt2MsgRes = postJson(
                "/api/pods/$pod1Id/dms/$peerA/messages",
                uB.token,
                mapOf("body" to "", "attachmentIds" to listOf(dmAtt2Id))
            )
            assertEquals(HttpStatus.CREATED, dmAtt2MsgRes.statusCode)
            val latestSummaryOnA = objectMapper.readTree(getJson("/api/pods", uA.token).body!!).path("pods")
                .first { it.path("podId").asText() == pod1Id }
                .path("dmConversations")[0]
            assertEquals("Sent an attachment", latestSummaryOnA.path("lastBody").asText())
            assertEquals(peerB, latestSummaryOnA.path("lastSenderPeerId").asText())

            val podsForB = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
                .first { it.path("podId").asText() == pod1Id }
            assertEquals(1, podsForB.path("dmConversations").size())
            assertEquals(peerA, podsForB.path("dmConversations")[0].path("peerId").asText())

            val podsForC = objectMapper.readTree(getJson("/api/pods", uC.token).body!!).path("pods")
                .first { it.path("podId").asText() == pod1Id }
            assertEquals(0, podsForC.path("dmConversations").size(), "User C must have empty dmConversations!")

            // Verify GET /api/pods/{pod1Id}/messages (Group Chat) NEVER includes any 1:1 DM rows!
            val groupFeed = objectMapper.readTree(getJson("/api/pods/$pod1Id/messages?beforeId=0&limit=50", uA.token).body!!).path("messages")
            assertFalse(groupFeed.any { it.path("id").asLong() in setOf(dm1Id, dm2Id, dmAttMsgId, shortDmId) })

            // Verify GET /api/pods/{pod1Id}/dms/{peerB}/messages returns the exact DM conversation
            val dmFeed = objectMapper.readTree(
                getJson("/api/pods/$pod1Id/dms/$peerB/messages?beforeId=0&limit=40", uA.token).body!!
            ).path("messages")
            assertTrue(dmFeed.size() >= 5)
            assertTrue(dmFeed.any { it.path("id").asLong() == dm1Id })
        } finally {
            runCatching { wsA.close() }
            runCatching { wsB.close() }
            runCatching { wsC.close() }
        }
    }

    @Test
    @Order(6)
    fun `native WebSocket hub manages single pod audio call voicePeers and relays WebRTC signals only between voice participants`() {
        val u0 = accounts[0]
        val u1 = accounts[1]
        val u2 = accounts[2]

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
            assertTrue(snap0.has("voicePeers") && !snap0.has("voiceRoster"))
            val peer0 = snap0.path("selfPeerId").asText()
            val peer1 = snap1.path("selfPeerId").asText()

            // 1. Live Group Chat message_created broadcast + private bookmark never leaks over WS
            val sendRes = postJson(
                "/api/pods/$pod1Id/messages",
                u0.token,
                mapOf("body" to "Live WebSocket broadcast check!")
            )
            assertEquals(HttpStatus.CREATED, sendRes.statusCode)
            val liveMsgOn1 = awaitFrame(q1) {
                it.path("type").asText() == "message_created" &&
                    it.path("message").path("body").asText() == "Live WebSocket broadcast check!"
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(liveMsgOn1))
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

            // 2. Single Pod Audio Call: peer0 joins voice -> voice_roster_updated with voicePeers
            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "voice_join", "muted" to false, "deafened" to false)
                    )
                )
            )

            val voiceUpdate1 = awaitFrame(q1) {
                it.path("type").asText() == "voice_roster_updated" && it.path("voicePeers").size() == 1
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(voiceUpdate1))
            assertEquals(peer0, voiceUpdate1.path("voicePeers")[0].path("peerId").asText())

            // Verify pod_members.in_voice == 1 reflected in GET /api/pods
            val podAfterJoin = objectMapper.readTree(getJson("/api/pods", u1.token).body!!).path("pods")
                .first { it.path("podId").asText() == pod1Id }
            assertTrue(
                podAfterJoin.path("members").first { it.path("peerId").asText() == peer0 }.path("inVoice").asBoolean()
            )

            // Sending webrtc_signal to peer1 BEFORE peer1 joins voice must be dropped!
            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "webrtc_signal", "targetPeerId" to peer1, "signal" to mapOf("type" to "offer"))
                    )
                )
            )
            assertNull(
                pollMatching(q1, 250L) { it.path("type").asText() == "webrtc_signal" },
                "webrtc_signal must require both sender and target to be in voice"
            )

            // Now peer1 joins voice too -> both in voice -> webrtc_signal relays ONLY to peer1!
            ws1.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "voice_join", "muted" to false, "deafened" to false)
                    )
                )
            )
            awaitFrame(q0) { it.path("type").asText() == "voice_roster_updated" && it.path("voicePeers").size() == 2 }

            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf(
                            "type" to "webrtc_signal",
                            "targetPeerId" to peer1,
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
            assertEquals("GROUP", signalOn1.path("scope").asText())
            assertFalse(signalOn1.has("voiceChannelId"))
            assertEquals("offer", signalOn1.path("signal").path("type").asText())

            val leakedToPeer2 = pollMatching(q2, 300L) { it.path("type").asText() == "webrtc_signal" }
            assertNull(leakedToPeer2, "webrtc_signal must only be delivered to targetPeerId")

            // Voice speaking state + voice_leave resets inVoice to false
            ws0.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "voice_state", "muted" to false, "deafened" to false, "speaking" to true)
                    )
                )
            )
            val speakingUpdate = awaitFrame(q1) {
                it.path("type").asText() == "voice_roster_updated" &&
                    it.path("voicePeers").any { p -> p.path("peerId").asText() == peer0 && p.path("speaking").asBoolean() }
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(speakingUpdate))

            ws0.sendMessage(TextMessage(objectMapper.writeValueAsString(mapOf("type" to "voice_leave"))))
            awaitFrame(q1) { it.path("type").asText() == "voice_roster_updated" && it.path("voicePeers").size() == 1 }
        } finally {
            runCatching { ws0.close() }
            runCatching { ws1.close() }
            runCatching { ws2.close() }
        }
    }

    @Test
    @Order(7)
    fun `cursor pagination for both Group Chat and 1-to-1 DMs and concurrent 7-user blind pod matching stay lock-safe`() {
        // 1a. Group Chat cursor pagination
        val page1Res = getJson("/api/pods/$pod1Id/messages?beforeId=0&limit=3", accounts[0].token)
        assertEquals(HttpStatus.OK, page1Res.statusCode)
        val page1Json = objectMapper.readTree(page1Res.body!!)
        val page1Msgs = page1Json.path("messages")
        assertEquals(3, page1Msgs.size())
        val nextCursor = page1Json.path("nextBeforeId").asLong()
        assertTrue(nextCursor > 0L)
        assertTrue(page1Msgs[0].path("id").asLong() < page1Msgs[2].path("id").asLong())

        val page2Res = getJson("/api/pods/$pod1Id/messages?beforeId=$nextCursor&limit=3", accounts[0].token)
        assertEquals(HttpStatus.OK, page2Res.statusCode)
        val page2Msgs = objectMapper.readTree(page2Res.body!!).path("messages")
        assertEquals(3, page2Msgs.size())
        assertTrue(page2Msgs[2].path("id").asLong() < page1Msgs[0].path("id").asLong())

        // 1b. 1:1 DM cursor pagination
        val peerB = objectMapper.readTree(getJson("/api/pods", accounts[1].token).body!!).path("pods")
            .first { it.path("podId").asText() == pod1Id }
            .path("myPeerId").asText()
        val dmPage1 = objectMapper.readTree(
            getJson("/api/pods/$pod1Id/dms/$peerB/messages?beforeId=0&limit=2", accounts[0].token).body!!
        )
        assertEquals(2, dmPage1.path("messages").size())
        val dmCursor = dmPage1.path("nextBeforeId").asLong()
        assertTrue(dmCursor > 0L)
        val dmPage2 = objectMapper.readTree(
            getJson("/api/pods/$pod1Id/dms/$peerB/messages?beforeId=$dmCursor&limit=2", accounts[0].token).body!!
        )
        assertEquals(2, dmPage2.path("messages").size())
        assertTrue(dmPage2.path("messages")[1].path("id").asLong() < dmPage1.path("messages")[0].path("id").asLong())

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
        assertTrue(chessPodCounts.values.all { it <= 6 })
    }

    @Test
    @Order(8)
    fun `multi-pod capacity presets forceNewPod allowAdditional and native mobile originless WebSocket succeed`() {
        val u0 = accounts[0]

        val badMatchRes = postJson("/api/pods/match", u0.token, mapOf("interest" to "gaming", "maxMembers" to 7))
        assertEquals(HttpStatus.BAD_REQUEST, badMatchRes.statusCode)
        assertTrue(badMatchRes.body!!.contains("maxMembers must be 4, 6, 10, 25, or 50"))

        val badLeaveRes = postJson("/api/pods/$pod1Id/leave", u0.token, mapOf("rematch" to true, "maxMembers" to 7))
        assertEquals(HttpStatus.BAD_REQUEST, badLeaveRes.statusCode)

        val cozyPodIds = mutableListOf<String>()
        for (i in 0 until 4) {
            val res = postJson("/api/pods/match", accounts[i].token, mapOf("interest" to "cozy-reading", "maxMembers" to 4))
            assertEquals(HttpStatus.OK, res.statusCode)
            assertZeroPiiLeak(res.body!!)
            cozyPodIds.add(objectMapper.readTree(res.body!!).path("matched")[0].path("podId").asText())
        }
        assertEquals(1, cozyPodIds.toSet().size)

        val fifthCozyRes = postJson("/api/pods/match", accounts[4].token, mapOf("interest" to "cozy-reading", "maxMembers" to 4))
        assertEquals(HttpStatus.OK, fifthCozyRes.statusCode)
        assertNotEquals(cozyPodIds.first(), objectMapper.readTree(fifthCozyRes.body!!).path("matched")[0].path("podId").asText())

        val loungePodIds = mutableSetOf<String>()
        var lastLoungeMemberCount = 0
        for (acc in accounts) {
            val res = postJson("/api/pods/match", acc.token, mapOf("interest" to "lounge-jazz", "maxMembers" to 10))
            assertEquals(HttpStatus.OK, res.statusCode)
            assertZeroPiiLeak(res.body!!)
            val pod = objectMapper.readTree(res.body!!).path("matched")[0]
            loungePodIds.add(pod.path("podId").asText())
            lastLoungeMemberCount = pod.path("memberCount").asInt()
        }
        assertEquals(1, loungePodIds.size)
        assertEquals(7, lastLoungeMemberCount)

        val secondGamingRes = postJson("/api/pods/match", u0.token, mapOf("interest" to "gaming", "allowAdditional" to true))
        assertEquals(HttpStatus.OK, secondGamingRes.statusCode)
        assertZeroPiiLeak(secondGamingRes.body!!)
        val secondGamingJson = objectMapper.readTree(secondGamingRes.body!!)
        assertEquals(pod2Id, secondGamingJson.path("matched")[0].path("podId").asText())

        val u0GamingPods = secondGamingJson.path("pods").filter { it.path("interestSlug").asText() == "gaming" }
        assertEquals(2, u0GamingPods.size)
        val gPod1 = u0GamingPods.first { it.path("podId").asText() == pod1Id }
        val gPod2 = u0GamingPods.first { it.path("podId").asText() == pod2Id }
        assertNotEquals(gPod1.path("myAlias").asText(), gPod2.path("myAlias").asText())
        assertNotEquals(gPod1.path("myPeerId").asText(), gPod2.path("myPeerId").asText())

        val forcedGamingRes = postJson(
            "/api/pods/match",
            u0.token,
            mapOf("interest" to "gaming", "maxMembers" to 4, "forceNewPod" to true)
        )
        assertEquals(HttpStatus.OK, forcedGamingRes.statusCode)
        val pod3Id = objectMapper.readTree(forcedGamingRes.body!!).path("matched")[0].path("podId").asText()

        val multiRematchRes = postJson(
            "/api/pods/$pod3Id/leave",
            u0.token,
            mapOf("rematch" to true, "maxMembers" to 10, "forceNewPod" to true)
        )
        assertEquals(HttpStatus.OK, multiRematchRes.statusCode)
        assertEquals(10, objectMapper.readTree(multiRematchRes.body!!).path("newPod").path("maxMembers").asInt())

        for (extra in 4..8) {
            val extraRes = postJson("/api/pods/match", u0.token, mapOf("interest" to "gaming", "maxMembers" to 4, "forceNewPod" to true))
            assertEquals(HttpStatus.OK, extraRes.statusCode)
        }
        val ninthRes = postJson("/api/pods/match", u0.token, mapOf("interest" to "gaming", "forceNewPod" to true))
        assertEquals(HttpStatus.BAD_REQUEST, ninthRes.statusCode)

        // Native mobile originless WebSocket + Expo Web Origin handshake
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
        val expoHeaders = org.springframework.web.socket.WebSocketHttpHeaders().apply { origin = "http://localhost:8081" }
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
    @Order(9)
    fun `pod invite links support zero-PII public preview opt-out rejoin idempotency single-use exhaustion and revocation`() {
        val u0 = accounts[0]
        val u5OptedOut = accounts[5]
        val u6Outsider = accounts[6]

        assertEquals(HttpStatus.FORBIDDEN, postJson("/api/pods/$pod1Id/invites", u6Outsider.token, emptyMap<String, Any>()).statusCode)
        assertEquals(HttpStatus.UNAUTHORIZED, postJson("/api/invites/k8m4p2x9q7w3/accept", null, emptyMap<String, Any>()).statusCode)

        val createRes = postJson("/api/pods/$pod1Id/invites", u0.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.CREATED, createRes.statusCode)
        assertZeroPiiLeak(createRes.body!!)
        val code = objectMapper.readTree(createRes.body!!).path("invite").path("code").asText()

        val reuseRes = postJson("/api/pods/$pod1Id/invites", u0.token, mapOf("regenerate" to false))
        assertEquals(HttpStatus.OK, reuseRes.statusCode)
        assertEquals(code, objectMapper.readTree(reuseRes.body!!).path("invite").path("code").asText())

        val publicPreviewRes = getJson("/api/invites/$code", null)
        assertEquals(HttpStatus.OK, publicPreviewRes.statusCode)
        assertZeroPiiLeak(publicPreviewRes.body!!)

        val wsClient = StandardWebSocketClient()
        val wsInbox: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val ws2 = connectPodWs(wsClient, pod1Id, accounts[2].token, wsInbox)
        try {
            awaitFrame(wsInbox) { it.path("type").asText() == "presence_snapshot" }

            val acceptRes = postJson("/api/invites/${code.uppercase()}/accept", u5OptedOut.token, emptyMap<String, Any>())
            assertEquals(HttpStatus.OK, acceptRes.statusCode)
            assertZeroPiiLeak(acceptRes.body!!)
            val acceptJson = objectMapper.readTree(acceptRes.body!!)
            assertFalse(acceptJson.path("alreadyMember").asBoolean())
            val rejoinedAlias = acceptJson.path("pod").path("myAlias").asText()

            val joinedFrame = awaitFrame(wsInbox) { it.path("type").asText() == "member_joined" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(joinedFrame))
            assertEquals(rejoinedAlias, joinedFrame.path("member").path("alias").asText())

            val sysMsgFrame = awaitFrame(wsInbox) {
                it.path("type").asText() == "message_created" &&
                    it.path("message").path("body").asText() == "$rejoinedAlias joined via invite link"
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(sysMsgFrame))

            // Ensure pod_updated broadcast to accounts[2] did NOT leak accounts[0]/accounts[1]'s dmConversations!
            val podUpdatedOn2 = awaitFrame(wsInbox) { it.path("type").asText() == "pod_updated" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(podUpdatedOn2))
            assertEquals(
                0,
                podUpdatedOn2.path("pod").path("dmConversations").size(),
                "pod_updated broadcast must personalize dmConversations per recipient and never leak others' DMs!"
            )
        } finally {
            runCatching { ws2.close() }
        }

        val reAcceptRes = postJson("/api/invites/$code/accept", u5OptedOut.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, reAcceptRes.statusCode)
        assertTrue(objectMapper.readTree(reAcceptRes.body!!).path("alreadyMember").asBoolean())

        assertEquals(HttpStatus.CONFLICT, postJson("/api/invites/$code/accept", u6Outsider.token, emptyMap<String, Any>()).statusCode)

        val astroMatch = postJson("/api/pods/match", u0.token, mapOf("interest" to "astronomy"))
        val astroPodId = objectMapper.readTree(astroMatch.body!!).path("matched")[0].path("podId").asText()
        val singleCode = objectMapper.readTree(
            postJson("/api/pods/$astroPodId/invites", u0.token, mapOf("maxUses" to 1, "expiresInHours" to 24, "regenerate" to true)).body!!
        ).path("invite").path("code").asText()
        assertEquals(HttpStatus.OK, postJson("/api/invites/$singleCode/accept", accounts[1].token, emptyMap<String, Any>()).statusCode)
        assertEquals(HttpStatus.GONE, postJson("/api/invites/$singleCode/accept", accounts[2].token, emptyMap<String, Any>()).statusCode)

        val revocableCode = objectMapper.readTree(
            postJson("/api/pods/$astroPodId/invites", u0.token, mapOf("maxUses" to 0, "expiresInHours" to 0, "regenerate" to true)).body!!
        ).path("invite").path("code").asText()
        assertEquals(HttpStatus.OK, exchangeJson(HttpMethod.DELETE, "/api/pods/$astroPodId/invites/$revocableCode", u0.token, null).statusCode)
        assertEquals(HttpStatus.GONE, postJson("/api/invites/$revocableCode/accept", accounts[2].token, emptyMap<String, Any>()).statusCode)
    }

    @Test
    @Order(10)
    fun `25-member default pods democratic YES-vs-NO governance engine and Canopy Pro custom admin groups succeed`() {
        val u0 = accounts[0]
        val u1 = accounts[1]
        val u2 = accounts[2]
        val u3 = accounts[3]
        val u4 = accounts[4]
        val u5 = accounts[5]

        // 1. Default matched pod has maxMembers == 25 and governanceMode == "DEMOCRATIC"
        val m0 = postJson("/api/pods/match", u0.token, mapOf("interest" to "tabletop-rpg"))
        assertEquals(HttpStatus.OK, m0.statusCode)
        assertZeroPiiLeak(m0.body!!)
        val rpgPod0 = objectMapper.readTree(m0.body!!).path("matched")[0]
        val rpgPodId = rpgPod0.path("podId").asText()
        assertEquals(25, rpgPod0.path("maxMembers").asInt())
        assertEquals("DEMOCRATIC", rpgPod0.path("governanceMode").asText())

        assertEquals(HttpStatus.OK, postJson("/api/pods/match", u1.token, mapOf("interest" to "tabletop-rpg")).statusCode)
        val m2 = postJson("/api/pods/match", u2.token, mapOf("interest" to "tabletop-rpg"))
        assertEquals(HttpStatus.OK, m2.statusCode)
        val rpgPod2 = objectMapper.readTree(m2.body!!).path("matched")[0]
        val u2PeerIdInRpg = rpgPod2.path("myPeerId").asText()
        val u2AliasInRpg = rpgPod2.path("myAlias").asText()

        // Removed channel proposal kinds must return 400 BAD_REQUEST
        assertEquals(
            HttpStatus.BAD_REQUEST,
            postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "ADD_CHANNEL", "label" to "nope")).statusCode
        )
        assertEquals(
            HttpStatus.BAD_REQUEST,
            postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "REMOVE_CHANNEL")).statusCode
        )

        val wsClient = StandardWebSocketClient()
        val q0: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val q1: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val ws0 = connectPodWs(wsClient, rpgPodId, u0.token, q0)
        val ws1 = connectPodWs(wsClient, rpgPodId, u1.token, q1)

        try {
            awaitFrame(q0) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(q1) { it.path("type").asText() == "presence_snapshot" }

            // 2a. UPDATE_TOPIC proposal in 3-member pod -> GOVERNANCE card posted in Group Chat -> passes at 2/3 YES!
            val topicPropRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf("kind" to "UPDATE_TOPIC", "topic" to "Weekly D&D campaigns & one-shots", "reason" to "Set room topic")
            )
            assertEquals(HttpStatus.CREATED, topicPropRes.statusCode, "Create proposal failed: ${topicPropRes.body}")
            assertZeroPiiLeak(topicPropRes.body!!)
            val topicPropId = objectMapper.readTree(topicPropRes.body!!).path("proposal").path("id").asLong()

            val propFrameOn1 = awaitFrame(q1) {
                it.path("type").asText() == "proposal_updated" &&
                    it.path("proposal").path("id").asLong() == topicPropId
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(propFrameOn1))
            assertTrue(propFrameOn1.path("proposal").path("myVote").isNull)

            val groupMsgsRes = getJson("/api/pods/$rpgPodId/messages?beforeId=0&limit=40", u1.token)
            assertEquals(HttpStatus.OK, groupMsgsRes.statusCode)
            val govMsg = objectMapper.readTree(groupMsgsRes.body!!).path("messages")
                .first { it.path("msgType").asText() == "GOVERNANCE" && it.path("proposal").path("id").asLong() == topicPropId }
            assertEquals("OPEN", govMsg.path("proposal").path("status").asText())

            val topicVoteRes = postJson("/api/proposals/$topicPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals(HttpStatus.OK, topicVoteRes.statusCode)
            assertEquals("PASSED", objectMapper.readTree(topicVoteRes.body!!).path("proposal").path("status").asText())
            assertEquals(
                "Weekly D&D campaigns & one-shots",
                objectMapper.readTree(topicVoteRes.body!!).path("pod").path("description").asText()
            )

            // 2b. Contested KICK_MEMBER proposal against u2: 1 Yes vs 1 No stays OPEN -> 2 Yes vs 1 No PASSES & kicks u2!
            val kickPropRes = postJson(
                "/api/pods/$rpgPodId/proposals",
                u0.token,
                mapOf("kind" to "KICK_MEMBER", "targetPeerId" to u2PeerIdInRpg, "reason" to "Spam")
            )
            assertEquals(HttpStatus.CREATED, kickPropRes.statusCode)
            val kickPropId = objectMapper.readTree(kickPropRes.body!!).path("proposal").path("id").asLong()
            assertEquals(u2AliasInRpg, objectMapper.readTree(kickPropRes.body!!).path("proposal").path("targetAlias").asText())

            val u2NoRes = postJson("/api/proposals/$kickPropId/vote", u2.token, mapOf("vote" to false))
            assertEquals("OPEN", objectMapper.readTree(u2NoRes.body!!).path("proposal").path("status").asText())

            val u1YesKickRes = postJson("/api/proposals/$kickPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals("PASSED", objectMapper.readTree(u1YesKickRes.body!!).path("proposal").path("status").asText())
            assertEquals(2, objectMapper.readTree(u1YesKickRes.body!!).path("pod").path("memberCount").asInt())

            val kickedFrame = awaitFrame(q0) {
                it.path("type").asText() == "member_kicked" && it.path("peerId").asText() == u2PeerIdInRpg
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(kickedFrame))

            // 2c. Tie rejection (1 Yes vs 1 No in 2-member pod -> REJECTED) + expired 1 Yes vs 0 No -> PASSED + TOGGLE_LOCK
            val capPropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "CHANGE_CAPACITY", "maxMembers" to 50)).body!!
            ).path("proposal").path("id").asLong()
            val capRejectRes = postJson("/api/proposals/$capPropId/vote", u1.token, mapOf("vote" to false))
            assertEquals("REJECTED", objectMapper.readTree(capRejectRes.body!!).path("proposal").path("status").asText())

            val renamePropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "RENAME_POD", "label" to "Arcane Guild", "expiresInMinutes" to 5)).body!!
            ).path("proposal").path("id").asLong()
            jdbcClient.sql("UPDATE pod_proposals SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE) WHERE id = :id")
                .param("id", renamePropId)
                .update()
            val resolveExpiredRes = postJson("/api/proposals/$renamePropId/resolve", u0.token, emptyMap<String, Any>())
            assertEquals("PASSED", objectMapper.readTree(resolveExpiredRes.body!!).path("proposal").path("status").asText())
            assertEquals("Arcane Guild", objectMapper.readTree(resolveExpiredRes.body!!).path("pod").path("title").asText())

            val lockPropId = objectMapper.readTree(
                postJson("/api/pods/$rpgPodId/proposals", u0.token, mapOf("kind" to "TOGGLE_LOCK", "locked" to true)).body!!
            ).path("proposal").path("id").asLong()
            val lockVoteRes = postJson("/api/proposals/$lockPropId/vote", u1.token, mapOf("vote" to true))
            assertEquals("PASSED", objectMapper.readTree(lockVoteRes.body!!).path("proposal").path("status").asText())
            assertFalse(objectMapper.readTree(lockVoteRes.body!!).path("pod").path("isOpen").asBoolean())
        } finally {
            runCatching { ws0.close() }
            runCatching { ws1.close() }
        }

        // 3. Canopy Pro Custom Owned Admin Pods & Publicized Directory
        assertEquals(
            HttpStatus.FORBIDDEN,
            postJson("/api/pods/custom", u3.token, mapOf("title" to "Raiders", "interest" to "tactical-raids")).statusCode
        )
        assertEquals(HttpStatus.OK, postJson("/api/auth/plan", u3.token, mapOf("planTier" to "PREMIUM")).statusCode)

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
        assertEquals(HttpStatus.CREATED, createCustomRes.statusCode)
        assertZeroPiiLeak(createCustomRes.body!!)
        val customPod = objectMapper.readTree(createCustomRes.body!!).path("pod")
        val customPodId = customPod.path("podId").asText()
        assertEquals("ADMIN", customPod.path("governanceMode").asText())
        assertEquals("OWNER", customPod.path("myRole").asText())
        assertFalse(customPod.has("channels"))

        val pubDirRes = getJson("/api/pods/publicized?interest=tactical-raids", u4.token)
        assertEquals(HttpStatus.OK, pubDirRes.statusCode)
        assertZeroPiiLeak(pubDirRes.body!!)
        assertEquals(1, objectMapper.readTree(pubDirRes.body!!).path("groups").size())

        val joinU4 = postJson("/api/pods/$customPodId/join", u4.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, joinU4.statusCode)
        val u4PeerId = objectMapper.readTree(joinU4.body!!).path("pod").path("myPeerId").asText()

        val joinU5 = postJson("/api/pods/$customPodId/join", u5.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, joinU5.statusCode)
        val u5PeerId = objectMapper.readTree(joinU5.body!!).path("pod").path("myPeerId").asText()

        assertEquals(
            HttpStatus.OK,
            postJson("/api/pods/$customPodId/admin/role", u3.token, mapOf("targetPeerId" to u4PeerId, "role" to "ADMIN")).statusCode
        )
        assertEquals(
            HttpStatus.OK,
            exchangeJson(HttpMethod.PATCH, "/api/pods/$customPodId/settings", u4.token, mapOf("title" to "Tactical Co-op Raiders HQ", "maxMembers" to 50)).statusCode
        )
        val adminKickRes = postJson("/api/pods/$customPodId/admin/kick", u3.token, mapOf("targetPeerId" to u5PeerId))
        assertEquals(HttpStatus.OK, adminKickRes.statusCode)
        assertEquals(2, objectMapper.readTree(adminKickRes.body!!).path("pod").path("memberCount").asInt())
        assertEquals(HttpStatus.FORBIDDEN, postJson("/api/pods/$customPodId/join", u5.token, emptyMap<String, Any>()).statusCode)
    }

    @Test
    @Order(11)
    fun `server-backed read cursors unread counts Seen receipts and private 1-to-1 DM audio calls isolate strictly to participants`() {
        val uA = accounts[0]
        val uB = accounts[1]
        val uC = accounts[2] // Bystander in the same pod!

        // 1. Match uA, uB, uC into a fresh pod ("synthwave-lounge")
        val mA = postJson("/api/pods/match", uA.token, mapOf("interest" to "synthwave-lounge"))
        val mB = postJson("/api/pods/match", uB.token, mapOf("interest" to "synthwave-lounge"))
        val mC = postJson("/api/pods/match", uC.token, mapOf("interest" to "synthwave-lounge"))
        assertEquals(HttpStatus.OK, mA.statusCode)
        assertEquals(HttpStatus.OK, mB.statusCode)
        assertEquals(HttpStatus.OK, mC.statusCode)

        val podNodeA = objectMapper.readTree(mA.body!!).path("matched")[0]
        val podNodeB = objectMapper.readTree(mB.body!!).path("matched")[0]
        val phase6PodId = podNodeA.path("podId").asText()
        val peerA = podNodeA.path("myPeerId").asText()
        val aliasA = podNodeA.path("myAlias").asText()
        val peerB = podNodeB.path("myPeerId").asText()
        val aliasB = podNodeB.path("myAlias").asText()

        // Initial unreadGroupCount > 0 (welcome + join SYSTEM messages have sender_user_id = 0 != myUserId)
        val initialPodB = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == phase6PodId }
        assertTrue(initialPodB.path("unreadGroupCount").asInt() >= 4, "Initial unreadGroupCount should reflect unread system messages")

        val initialMsgs = objectMapper.readTree(getJson("/api/pods/$phase6PodId/messages?beforeId=0&limit=40", uA.token).body!!).path("messages")
        val latestSysMsgId = initialMsgs.last().path("id").asLong()

        // Mark Group Chat read up to latestSysMsgId for uA, uB, and uC -> unreadGroupCount drops to 0
        for (acc in listOf(uA, uB, uC)) {
            val readRes = postJson("/api/pods/$phase6PodId/read", acc.token, mapOf("peerId" to null, "lastReadMessageId" to latestSysMsgId))
            assertEquals(HttpStatus.OK, readRes.statusCode)
            assertEquals(latestSysMsgId, objectMapper.readTree(readRes.body!!).path("lastReadMessageId").asLong())
        }
        val clearedPodB = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == phase6PodId }
        assertEquals(0, clearedPodB.path("unreadGroupCount").asInt())

        // 2. Offline/unread Group Chat count + sender auto-advance + monotonic GREATEST read cursor
        val g1Res = postJson("/api/pods/$phase6PodId/messages", uA.token, mapOf("body" to "Synth patch #1"))
        val g2Res = postJson("/api/pods/$phase6PodId/messages", uA.token, mapOf("body" to "Synth patch #2"))
        val g2Id = objectMapper.readTree(g2Res.body!!).path("message").path("id").asLong()
        assertEquals(HttpStatus.CREATED, g1Res.statusCode)
        assertEquals(HttpStatus.CREATED, g2Res.statusCode)

        val afterSendPodA = objectMapper.readTree(getJson("/api/pods", uA.token).body!!).path("pods")
            .first { it.path("podId").asText() == phase6PodId }
        val afterSendPodB = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == phase6PodId }
        val afterSendPodC = objectMapper.readTree(getJson("/api/pods", uC.token).body!!).path("pods")
            .first { it.path("podId").asText() == phase6PodId }
        assertEquals(0, afterSendPodA.path("unreadGroupCount").asInt(), "Sender's own unreadGroupCount must stay 0 via auto-advance")
        assertEquals(2, afterSendPodB.path("unreadGroupCount").asInt(), "Unread member B must see unreadGroupCount = 2")
        assertEquals(2, afterSendPodC.path("unreadGroupCount").asInt(), "Unread member C must see unreadGroupCount = 2")

        val markGroupB = postJson("/api/pods/$phase6PodId/read", uB.token, mapOf("lastReadMessageId" to g2Id))
        assertEquals(HttpStatus.OK, markGroupB.statusCode)
        assertEquals(g2Id, objectMapper.readTree(markGroupB.body!!).path("lastReadMessageId").asLong())
        // Regression check: posting a smaller lastReadMessageId must NOT move cursor backward
        val staleMarkB = postJson("/api/pods/$phase6PodId/read", uB.token, mapOf("lastReadMessageId" to 1L))
        assertEquals(g2Id, objectMapper.readTree(staleMarkB.body!!).path("lastReadMessageId").asLong())
        assertEquals(
            0,
            objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
                .first { it.path("podId").asText() == phase6PodId }.path("unreadGroupCount").asInt()
        )

        // 3. 1:1 DM unreadCount + peerLastReadMessageId (Seen ✓✓) + live dm_read WS isolation
        val dm1 = postJson("/api/pods/$phase6PodId/dms/$peerB/messages", uA.token, mapOf("body" to "Hey, got 5 mins for an audio check?"))
        val dm2 = postJson("/api/pods/$phase6PodId/dms/$peerB/messages", uA.token, mapOf("body" to "Ring whenever ready!"))
        assertEquals(HttpStatus.CREATED, dm1.statusCode)
        assertEquals(HttpStatus.CREATED, dm2.statusCode)
        val dm2Id = objectMapper.readTree(dm2.body!!).path("message").path("id").asLong()

        val dmsBeforeReadA = objectMapper.readTree(getJson("/api/pods/$phase6PodId/dms", uA.token).body!!).path("conversations")
        assertEquals(1, dmsBeforeReadA.size())
        assertEquals(0, dmsBeforeReadA[0].path("unreadCount").asInt(), "Sender uA has 0 unread from uB")
        assertEquals(0L, dmsBeforeReadA[0].path("peerLastReadMessageId").asLong(), "uB has not read uA's DMs yet (Sent ✓)")

        val dmsBeforeReadB = objectMapper.readTree(getJson("/api/pods/$phase6PodId/dms", uB.token).body!!).path("conversations")
        assertEquals(1, dmsBeforeReadB.size())
        assertEquals(2, dmsBeforeReadB[0].path("unreadCount").asInt(), "Recipient uB must see unreadCount = 2")
        assertEquals(dm2Id, dmsBeforeReadB[0].path("peerLastReadMessageId").asLong(), "uA's cursor auto-advanced to dm2Id on send")

        val wsClient = StandardWebSocketClient()
        val qA: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val qB: BlockingQueue<JsonNode> = LinkedBlockingQueue()
        val qC: BlockingQueue<JsonNode> = LinkedBlockingQueue()

        val wsA = connectPodWs(wsClient, phase6PodId, uA.token, qA)
        var wsB = connectPodWs(wsClient, phase6PodId, uB.token, qB)
        val wsC = connectPodWs(wsClient, phase6PodId, uC.token, qC)

        try {
            awaitFrame(qA) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(qB) { it.path("type").asText() == "presence_snapshot" }
            awaitFrame(qC) { it.path("type").asText() == "presence_snapshot" }
            qA.clear()
            qB.clear()
            qC.clear()

            // uB marks 1:1 DM from uA as read -> live dm_read delivered ONLY to {uA, uB}, ZERO frames to uC!
            val dmReadRes = postJson(
                "/api/pods/$phase6PodId/read",
                uB.token,
                mapOf("peerId" to peerA, "lastReadMessageId" to dm2Id)
            )
            assertEquals(HttpStatus.OK, dmReadRes.statusCode)
            assertZeroPiiLeak(dmReadRes.body!!)
            assertEquals(dm2Id, objectMapper.readTree(dmReadRes.body!!).path("lastReadMessageId").asLong())

            val dmReadOnA = awaitFrame(qA) { it.path("type").asText() == "dm_read" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmReadOnA))
            assertEquals(peerB, dmReadOnA.path("peerId").asText())
            assertEquals(peerA, dmReadOnA.path("targetPeerId").asText())
            assertEquals(dm2Id, dmReadOnA.path("lastReadMessageId").asLong())
            awaitFrame(qB) { it.path("type").asText() == "dm_read" }

            assertNull(pollMatching(qC, 300L) { true }, "Bystander User C must receive ZERO frames on dm_read!")

            val dmsAfterReadA = objectMapper.readTree(getJson("/api/pods/$phase6PodId/dms", uA.token).body!!).path("conversations")[0]
            val dmsAfterReadB = objectMapper.readTree(getJson("/api/pods/$phase6PodId/dms", uB.token).body!!).path("conversations")[0]
            assertEquals(dm2Id, dmsAfterReadA.path("peerLastReadMessageId").asLong(), "uA now sees peerLastReadMessageId == dm2Id (Seen ✓✓)")
            assertEquals(0, dmsAfterReadB.path("unreadCount").asInt(), "uB unreadCount cleared to 0")

            // 4. Private 1:1 Member Audio Call lifecycle (strictly invisible to bystander User C!)
            // 4a. webrtc_signal(scope="DM") without an active call must be dropped
            wsA.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "webrtc_signal", "targetPeerId" to peerB, "scope" to "DM", "signal" to mapOf("type" to "offer"))
                    )
                )
            )
            assertNull(pollMatching(qB, 250L) { it.path("type").asText() == "webrtc_signal" })

            // 4b. Ring + Decline flow
            wsA.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_ring", "targetPeerId" to peerB)))
            )
            val ringing1 = awaitFrame(qA) { it.path("type").asText() == "dm_call_ringing" }
            val incoming1 = awaitFrame(qB) { it.path("type").asText() == "dm_call_incoming" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(ringing1))
            assertZeroPiiLeak(objectMapper.writeValueAsString(incoming1))
            assertEquals(peerB, ringing1.path("targetPeerId").asText())
            assertEquals(aliasB, ringing1.path("targetAlias").asText())
            assertTrue(ringing1.path("targetOnline").asBoolean())
            assertEquals(peerA, incoming1.path("fromPeerId").asText())
            assertEquals(aliasA, incoming1.path("fromAlias").asText())

            wsB.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_decline", "callerPeerId" to peerA)))
            )
            val declinedOnA = awaitFrame(qA) { it.path("type").asText() == "dm_call_ended" }
            awaitFrame(qB) { it.path("type").asText() == "dm_call_ended" }
            assertEquals(peerB, declinedOnA.path("byPeerId").asText())
            assertEquals("declined", declinedOnA.path("reason").asText())

            // 4c. Full Ring -> Accept -> Connected -> WebRTC (scope="DM") -> State -> End flow
            wsA.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_ring", "targetPeerId" to peerB)))
            )
            awaitFrame(qA) { it.path("type").asText() == "dm_call_ringing" }
            awaitFrame(qB) { it.path("type").asText() == "dm_call_incoming" }

            wsB.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_accept", "callerPeerId" to peerA)))
            )
            val connectedOnA = awaitFrame(qA) { it.path("type").asText() == "dm_call_connected" }
            val connectedOnB = awaitFrame(qB) { it.path("type").asText() == "dm_call_connected" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(connectedOnA))
            assertEquals(peerA, connectedOnA.path("peerAId").asText())
            assertEquals(peerB, connectedOnA.path("peerBId").asText())
            assertEquals(peerA, connectedOnB.path("peerAId").asText())

            wsA.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf(
                            "type" to "webrtc_signal",
                            "targetPeerId" to peerB,
                            "scope" to "DM",
                            "signal" to mapOf("type" to "offer", "sdp" to "v=0\r\no=- 999 2 IN IP4 127.0.0.1\r\n")
                        )
                    )
                )
            )
            val dmSignalOnB = awaitFrame(qB) { it.path("type").asText() == "webrtc_signal" }
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmSignalOnB))
            assertEquals(peerA, dmSignalOnB.path("fromPeerId").asText())
            assertEquals("DM", dmSignalOnB.path("scope").asText())
            assertEquals("offer", dmSignalOnB.path("signal").path("type").asText())

            wsB.sendMessage(
                TextMessage(
                    objectMapper.writeValueAsString(
                        mapOf("type" to "dm_call_state", "peerId" to peerA, "muted" to false, "speaking" to true)
                    )
                )
            )
            val dmStateOnA = awaitFrame(qA) {
                it.path("type").asText() == "dm_call_state" && it.path("fromPeerId").asText() == peerB
            }
            assertZeroPiiLeak(objectMapper.writeValueAsString(dmStateOnA))
            assertTrue(dmStateOnA.path("speaking").asBoolean())

            wsA.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_end", "peerId" to peerB)))
            )
            val endedOnB = awaitFrame(qB) { it.path("type").asText() == "dm_call_ended" }
            awaitFrame(qA) { it.path("type").asText() == "dm_call_ended" }
            assertEquals(peerA, endedOnB.path("byPeerId").asText())
            assertEquals("ended", endedOnB.path("reason").asText())

            // Bystander User C MUST have received ZERO frames across the entire 1:1 DM call session!
            assertNull(
                pollMatching(qC, 350L) { true },
                "Bystander User C must receive ZERO WS frames during User A <-> User B's private 1:1 call!"
            )

            // 4d. Auto-teardown on WebSocket disconnect -> reason = "disconnected"
            wsA.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_ring", "targetPeerId" to peerB)))
            )
            awaitFrame(qA) { it.path("type").asText() == "dm_call_ringing" }
            awaitFrame(qB) { it.path("type").asText() == "dm_call_incoming" }
            wsB.sendMessage(
                TextMessage(objectMapper.writeValueAsString(mapOf("type" to "dm_call_accept", "callerPeerId" to peerA)))
            )
            awaitFrame(qA) { it.path("type").asText() == "dm_call_connected" }
            awaitFrame(qB) { it.path("type").asText() == "dm_call_connected" }

            wsB.close()
            val disconnectEndOnA = awaitFrame(qA) { it.path("type").asText() == "dm_call_ended" }
            assertEquals(peerB, disconnectEndOnA.path("byPeerId").asText())
            assertEquals("disconnected", disconnectEndOnA.path("reason").asText())

            // User C only gets presence_snapshot from B going offline — NEVER any dm_call_* frame!
            val leakedCallFrameToC = pollMatching(qC, 350L) { it.path("type").asText().startsWith("dm_") }
            assertNull(leakedCallFrameToC, "Bystander User C must never receive dm_call_* on disconnect")
        } finally {
            runCatching { wsA.close() }
            runCatching { wsB.close() }
            runCatching { wsC.close() }
        }
    }

    @Test
    @Order(12)
    fun `room mute poll closing read-all and server-side coin and dice slash commands work cleanly with zero PII`() {
        val uA = accounts[0]
        val uB = accounts[1]

        val matchA = postJson("/api/pods/match", uA.token, mapOf("interest" to "board-games"))
        val matchB = postJson("/api/pods/match", uB.token, mapOf("interest" to "board-games"))
        assertEquals(HttpStatus.OK, matchA.statusCode)
        assertEquals(HttpStatus.OK, matchB.statusCode)

        val podNodeA = objectMapper.readTree(matchA.body!!).path("matched")[0]
        val podNodeB = objectMapper.readTree(matchB.body!!).path("matched")[0]
        val bgPodId = podNodeA.path("podId").asText()
        val peerB = podNodeB.path("myPeerId").asText()
        assertFalse(podNodeA.path("myMuted").asBoolean())

        // 1. Mute and unmute room (per-user, never affects uB)
        val muteRes = exchangeJson(HttpMethod.PATCH, "/api/pods/$bgPodId/mute", uA.token, mapOf("muted" to true))
        assertEquals(HttpStatus.OK, muteRes.statusCode)
        assertZeroPiiLeak(muteRes.body!!)
        assertTrue(objectMapper.readTree(muteRes.body!!).path("muted").asBoolean())

        val podAAfterMute = objectMapper.readTree(getJson("/api/pods", uA.token).body!!).path("pods")
            .first { it.path("podId").asText() == bgPodId }
        val podBAfterMute = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == bgPodId }
        assertTrue(podAAfterMute.path("myMuted").asBoolean())
        assertFalse(podBAfterMute.path("myMuted").asBoolean())

        val unmuteRes = exchangeJson(HttpMethod.PATCH, "/api/pods/$bgPodId/mute", uA.token, mapOf("muted" to false))
        assertEquals(HttpStatus.OK, unmuteRes.statusCode)
        assertFalse(objectMapper.readTree(unmuteRes.body!!).path("muted").asBoolean())

        // 2. Poll creation + vote + close permission check (non-author uB rejected -> author uA closes -> subsequent vote rejected)
        val pollRes = postJson(
            "/api/pods/$bgPodId/messages",
            uA.token,
            mapOf("body" to "/poll \"Next game?\" \"Catan\" \"Wingspan\"")
        )
        assertEquals(HttpStatus.CREATED, pollRes.statusCode)
        assertZeroPiiLeak(pollRes.body!!)
        val pollId = objectMapper.readTree(pollRes.body!!).path("message").path("poll").path("pollId").asLong()

        assertEquals(HttpStatus.OK, postJson("/api/polls/$pollId/vote", uB.token, mapOf("optionIndex" to 1)).statusCode)
        assertEquals(HttpStatus.FORBIDDEN, postJson("/api/polls/$pollId/close", uB.token, emptyMap<String, Any>()).statusCode)

        val closeRes = postJson("/api/polls/$pollId/close", uA.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, closeRes.statusCode)
        assertZeroPiiLeak(closeRes.body!!)
        assertTrue(objectMapper.readTree(closeRes.body!!).path("message").path("poll").path("isClosed").asBoolean())
        assertEquals(HttpStatus.BAD_REQUEST, postJson("/api/polls/$pollId/vote", uA.token, mapOf("optionIndex" to 0)).statusCode)

        // 3. Fair server-side /coin and /roll in Group Chat and 1:1 DM
        val coinRes = postJson("/api/pods/$bgPodId/messages", uA.token, mapOf("body" to "/coin"))
        assertEquals(HttpStatus.CREATED, coinRes.statusCode)
        assertZeroPiiLeak(coinRes.body!!)
        val coinBody = objectMapper.readTree(coinRes.body!!).path("message").path("body").asText()
        assertTrue(coinBody.contains("flipped a coin: **Heads**") || coinBody.contains("flipped a coin: **Tails**"))

        val rollRes = postJson("/api/pods/$bgPodId/dms/$peerB/messages", uA.token, mapOf("body" to "/roll 2d6"))
        assertEquals(HttpStatus.CREATED, rollRes.statusCode)
        assertZeroPiiLeak(rollRes.body!!)
        val rollBody = objectMapper.readTree(rollRes.body!!).path("message").path("body").asText()
        assertTrue(rollBody.contains("rolled 2d6: **"))

        val badRollRes = postJson("/api/pods/$bgPodId/messages", uA.token, mapOf("body" to "/roll 99d6"))
        assertEquals(HttpStatus.BAD_REQUEST, badRollRes.statusCode)

        // 4. Mark all read clears both Group Chat and 1:1 DM unread counts across all of uB's pods
        val podsBeforeReadAll = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == bgPodId }
        assertTrue(podsBeforeReadAll.path("unreadGroupCount").asInt() > 0)
        assertTrue(podsBeforeReadAll.path("dmConversations").any { it.path("unreadCount").asInt() > 0 })

        val readAllRes = postJson("/api/pods/read-all", uB.token, emptyMap<String, Any>())
        assertEquals(HttpStatus.OK, readAllRes.statusCode)
        assertZeroPiiLeak(readAllRes.body!!)
        assertTrue(objectMapper.readTree(readAllRes.body!!).path("updatedConversations").asInt() >= 2)

        val podsAfterReadAll = objectMapper.readTree(getJson("/api/pods", uB.token).body!!).path("pods")
            .first { it.path("podId").asText() == bgPodId }
        assertEquals(0, podsAfterReadAll.path("unreadGroupCount").asInt())
        assertTrue(podsAfterReadAll.path("dmConversations").all { it.path("unreadCount").asInt() == 0 })
    }

    private fun uploadAttachment(
        podId: String,
        bearerToken: String,
        filename: String,
        kind: String,
        durationMs: Int
    ): Long {
        val multipartHeaders = HttpHeaders().apply {
            contentType = MediaType.MULTIPART_FORM_DATA
            setBearerAuth(bearerToken)
        }
        val fileResource = object : ByteArrayResource(ByteArray(256) { 0x42 }) {
            override fun getFilename(): String = filename
        }
        val form = LinkedMultiValueMap<String, Any>().apply {
            add("file", fileResource)
            add("kind", kind)
            add("durationMs", durationMs.toString())
        }
        val uploadRes = restTemplate.exchange(
            "/api/pods/$podId/attachments",
            HttpMethod.POST,
            HttpEntity(form, multipartHeaders),
            String::class.java
        )
        assertEquals(HttpStatus.CREATED, uploadRes.statusCode, "Upload failed: ${uploadRes.body}")
        assertZeroPiiLeak(uploadRes.body!!)
        return objectMapper.readTree(uploadRes.body!!).path("id").asLong()
    }

    private fun downloadAttachment(attachmentId: Long, bearerToken: String): ResponseEntity<ByteArray> {
        val headers = HttpHeaders().apply { setBearerAuth(bearerToken) }
        return restTemplate.exchange(
            "/api/attachments/$attachmentId",
            HttpMethod.GET,
            HttpEntity<Void>(headers),
            ByteArray::class.java
        )
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
