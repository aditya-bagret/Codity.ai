import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { useDb } from "../helpers";

useDb();
const app = createApp();

async function register(email: string, name = "Tester") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "password123", name });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string } };
}

describe("authentication", () => {
  it("registers a user with a personal org and returns a working token", async () => {
    const { token, user } = await register("alice@test.dev", "Alice");
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    const orgs = await request(app).get("/api/orgs").set("Authorization", `Bearer ${token}`);
    expect(orgs.status).toBe(200);
    expect(orgs.body.data).toHaveLength(1);
    expect(orgs.body.data[0].role).toBe("owner");
  });

  it("rejects duplicate emails with 409", async () => {
    await register("dup@test.dev");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "DUP@test.dev", password: "password123", name: "Dup" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates registration input", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: "short", name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toHaveProperty("email");
    expect(res.body.error.details).toHaveProperty("password");
  });

  it("rejects bad credentials and missing tokens", async () => {
    await register("bob@test.dev");
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: "bob@test.dev", password: "wrong-password" });
    expect(bad.status).toBe(401);

    const anon = await request(app).get("/api/projects");
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHORIZED");
  });

  it("logs in case-insensitively on email", async () => {
    await register("carol@test.dev");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "CAROL@test.dev", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe("API keys and RBAC", () => {
  async function setupProject() {
    const { token } = await register(`owner-${Date.now()}@test.dev`, "Owner");
    const orgs = await request(app).get("/api/orgs").set("Authorization", `Bearer ${token}`);
    const orgId = orgs.body.data[0].id as string;
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ organizationId: orgId, name: "Proj" });
    expect(project.status).toBe(201);
    return { token, orgId, project: project.body.project as { id: string; apiKey: string } };
  }

  it("scopes API-key callers to their own project with member rights", async () => {
    const { project } = await setupProject();

    const list = await request(app).get("/api/projects").set("X-Api-Key", project.apiKey);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(project.id);

    // API keys cannot act on user/org endpoints.
    const orgs = await request(app).get("/api/orgs").set("X-Api-Key", project.apiKey);
    expect(orgs.status).toBe(403);

    const badKey = await request(app).get("/api/projects").set("X-Api-Key", "ck_nope");
    expect(badKey.status).toBe(401);
  });

  it("hides projects from non-members and enforces role ranks", async () => {
    const { token: ownerToken, orgId, project } = await setupProject();
    const { token: strangerToken, user: stranger } = await register("stranger@test.dev");

    // Non-member: existence is not leaked.
    const hidden = await request(app)
      .get(`/api/projects/${project.id}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(hidden.status).toBe(404);

    // Add as member → read works, admin actions still forbidden.
    const add = await request(app)
      .post(`/api/orgs/${orgId}/members`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "stranger@test.dev", role: "member" });
    expect(add.status).toBe(201);

    const visible = await request(app)
      .get(`/api/projects/${project.id}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(visible.status).toBe(200);
    expect(visible.body.role).toBe("member");
    expect(visible.body.project.apiKey).toBeNull(); // members don't see the key

    const rotate = await request(app)
      .post(`/api/projects/${project.id}/rotate-api-key`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(rotate.status).toBe(403);

    const del = await request(app)
      .delete(`/api/projects/${project.id}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(del.status).toBe(403);

    // Members cannot remove the owner.
    const removeOwner = await request(app)
      .delete(`/api/orgs/${orgId}/members/${stranger.id}`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(removeOwner.status).toBe(403);
  });
});
