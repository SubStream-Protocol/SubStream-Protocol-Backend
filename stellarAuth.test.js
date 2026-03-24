const request = require("supertest");
const app = require("./index");
const StellarSdk = require("@stellar/stellar-sdk");

describe("Stellar Authentication (SIWS)", () => {
  let testKeypair;
  let testPublicKey;
  let authToken;
  let challengeXDR;

  beforeAll(() => {
    // Generate test keypair for testing
    testKeypair = StellarSdk.Keypair.random();
    testPublicKey = testKeypair.publicKey();
  });

  describe("POST /auth/stellar/challenge", () => {
    it("should generate a challenge for valid public key", async () => {
      const response = await request(app)
        .get("/auth/stellar/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.challenge).toBeDefined();
      expect(response.body.nonce).toBeDefined();
      expect(response.body.expiresAt).toBeDefined();

      challengeXDR = response.body.challenge;
    });

    it("should reject request without public key", async () => {
      const response = await request(app)
        .get("/auth/stellar/challenge")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Stellar public key required");
    });

    it("should reject invalid public key format", async () => {
      const response = await request(app)
        .get("/auth/stellar/challenge")
        .query({ publicKey: "invalid-key" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid Stellar public key format");
    });
  });

  describe("POST /auth/stellar/login", () => {
    it("should reject login without required fields", async () => {
      const response = await request(app)
        .post("/auth/stellar/login")
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe(
        "Missing required fields: publicKey, challengeXDR",
      );
    });

    it("should reject invalid challenge XDR", async () => {
      const response = await request(app)
        .post("/auth/stellar/login")
        .send({
          publicKey: testPublicKey,
          challengeXDR: "invalid-xdr",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    // Note: Full integration test with signed challenge would require
    // testnet account setup and funding, which is complex for unit tests
    // In production, you'd set up funded test accounts for integration testing
  });

  describe("GET /auth/stellar/session", () => {
    it("should reject request without authentication", async () => {
      const response = await request(app)
        .get("/auth/stellar/session")
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Access token required");
    });
  });

  describe("POST /auth/stellar/logout", () => {
    it("should reject logout without authentication", async () => {
      const response = await request(app)
        .post("/auth/stellar/logout")
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Access token required");
    });
  });

  describe("GET /auth/stellar/challenge-status", () => {
    it("should return challenge status for valid public key", async () => {
      // First generate a challenge
      await request(app)
        .get("/auth/stellar/challenge")
        .query({ publicKey: testPublicKey });

      // Then check status
      const response = await request(app)
        .get("/auth/stellar/challenge-status")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.status).toBeDefined();
      expect(response.body.status.exists).toBe(true);
    });

    it("should reject request without public key", async () => {
      const response = await request(app)
        .get("/auth/stellar/challenge-status")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Public key required");
    });
  });

  describe("POST /auth/stellar/validate-sessions", () => {
    it("should validate all active sessions", async () => {
      const response = await request(app)
        .post("/auth/stellar/validate-sessions")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.invalidatedSessions).toBeDefined();
      expect(Array.isArray(response.body.invalidatedSessions)).toBe(true);
    });
  });
});

// Integration tests (require testnet setup)
describe("Stellar Authentication Integration Tests", () => {
  let fundedKeypair;
  let fundedPublicKey;

  beforeAll(async () => {
    // These tests require a funded testnet account
    // Skip if test credentials are not available
    if (
      !process.env.STELLAR_TEST_PUBLIC_KEY ||
      !process.env.STELLAR_TEST_SECRET
    ) {
      console.log("Skipping integration tests - no test credentials provided");
      return;
    }

    fundedPublicKey = process.env.STELLAR_TEST_PUBLIC_KEY;
    fundedKeypair = StellarSdk.Keypair.fromSecret(
      process.env.STELLAR_TEST_SECRET,
    );
  });

  it("should complete full authentication flow", async () => {
    if (!fundedKeypair) {
      console.log("Skipping integration test");
      return;
    }

    // 1. Generate challenge
    const challengeResponse = await request(app)
      .get("/auth/stellar/challenge")
      .query({ publicKey: fundedPublicKey })
      .expect(200);

    expect(challengeResponse.body.success).toBe(true);

    // 2. Parse and sign the challenge
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      challengeResponse.body.challenge,
      "Test SDF Network ; September 2015",
    );

    transaction.sign(fundedKeypair);
    const signedChallengeXDR = transaction.toXDR();

    // 3. Verify and login
    const loginResponse = await request(app)
      .post("/auth/stellar/login")
      .send({
        publicKey: fundedPublicKey,
        challengeXDR: signedChallengeXDR,
      })
      .expect(200);

    expect(loginResponse.body.success).toBe(true);
    expect(loginResponse.body.token).toBeDefined();
    expect(loginResponse.body.user.publicKey).toBe(
      fundedPublicKey.toLowerCase(),
    );

    const token = loginResponse.body.token;

    // 4. Test authenticated endpoint
    const sessionResponse = await request(app)
      .get("/auth/stellar/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(sessionResponse.body.success).toBe(true);
    expect(sessionResponse.body.session.publicKey).toBe(
      fundedPublicKey.toLowerCase(),
    );

    // 5. Test logout
    const logoutResponse = await request(app)
      .post("/auth/stellar/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(logoutResponse.body.success).toBe(true);
  }, 30000); // Longer timeout for network operations
});
