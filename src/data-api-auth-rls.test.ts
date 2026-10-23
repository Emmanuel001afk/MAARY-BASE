import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("project authentication flows: signup, email verification, token rotation & reuse detection, recovery, OAuth, and admin ban", async () => {
  const app = await buildApp();
  try {
    const opReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `auth-op-${Date.now()}@maary.dev`,
        password: "OperatorPass123!",
      },
    });
    const opToken = opReg.json().accessToken as string;

    const slug = `auth-proj-${Date.now()}`;
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${opToken}` },
      payload: { name: "Auth Test Project", slug },
    });
    assert.equal(projRes.statusCode, 201);
    const anonKey = projRes.json().apiKeys.anonKey as string;

    // 1. Configure require_email_verification = true and enable GitHub OAuth
    const cfgRes = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slug}/auth/config`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        allow_public_signup: true,
        require_email_verification: true,
        password_min_length: 8,
        oauth_providers: {
          github: {
            enabled: true,
            clientId: "gh_client_123",
            scopes: ["read:user", "user:email"],
          },
        },
      },
    });
    assert.equal(cfgRes.statusCode, 200);
    assert.equal(cfgRes.json().config.require_email_verification, true);

    // 2. Sign up end-user -> receives verificationToken, session is null until verified
    const signupRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: anonKey },
      payload: {
        email: "alice@example.com",
        password: "AlicePassword123!",
        user_metadata: { fullName: "Alice Wonderland" },
      },
    });
    assert.equal(signupRes.statusCode, 201);
    const signupBody = signupRes.json();
    assert.equal(signupBody.session, null);
    assert.ok(signupBody.verificationToken);

    // Attempt login before email verification -> 403 Forbidden
    const unverifiedLogin = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/login`,
      headers: { apikey: anonKey },
      payload: {
        email: "alice@example.com",
        password: "AlicePassword123!",
      },
    });
    assert.equal(unverifiedLogin.statusCode, 403);

    // Verify email using token
    const verifyRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/verify`,
      headers: { apikey: anonKey },
      payload: { token: signupBody.verificationToken },
    });
    assert.equal(verifyRes.statusCode, 200);
    assert.equal(verifyRes.json().verified, true);
    assert.equal(verifyRes.json().user.email_verified, true);

    // 3. Login after email verification -> 200 OK with access_token and refresh_token
    const loginRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/login`,
      headers: { apikey: anonKey },
      payload: {
        email: "alice@example.com",
        password: "AlicePassword123!",
      },
    });
    assert.equal(loginRes.statusCode, 200);
    const session1 = loginRes.json();
    assert.ok(session1.access_token);
    assert.ok(session1.refresh_token);

    // 4. Refresh token rotation & reuse detection
    const refresh1 = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/refresh`,
      headers: { apikey: anonKey },
      payload: { refresh_token: session1.refresh_token },
    });
    assert.equal(refresh1.statusCode, 200);
    const session2 = refresh1.json();
    assert.notEqual(session2.refresh_token, session1.refresh_token);

    // Replay old refresh token (session1.refresh_token) -> triggers reuse detection and revokes the entire token family!
    const replayAttempt = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/refresh`,
      headers: { apikey: anonKey },
      payload: { refresh_token: session1.refresh_token },
    });
    assert.equal(replayAttempt.statusCode, 401);

    // Even session2.refresh_token in the compromised family is now revoked!
    const familyRevokedCheck = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/refresh`,
      headers: { apikey: anonKey },
      payload: { refresh_token: session2.refresh_token },
    });
    assert.equal(familyRevokedCheck.statusCode, 401);

    // 5. Password Recovery Flow
    const recoverRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/recover`,
      headers: { apikey: anonKey },
      payload: { email: "alice@example.com" },
    });
    assert.equal(recoverRes.statusCode, 200);
    const recoveryToken = recoverRes.json().recoveryToken as string;
    assert.ok(recoveryToken);

    const resetRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/reset-password`,
      headers: { apikey: anonKey },
      payload: {
        token: recoveryToken,
        password: "NewAlicePassword999!",
      },
    });
    assert.equal(resetRes.statusCode, 200);
    assert.equal(resetRes.json().passwordReset, true);

    // Login with new password succeeds
    const reloginRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/login`,
      headers: { apikey: anonKey },
      payload: {
        email: "alice@example.com",
        password: "NewAlicePassword999!",
      },
    });
    assert.equal(reloginRes.statusCode, 200);
    const aliceToken = reloginRes.json().access_token as string;
    const aliceId = reloginRes.json().user.id as string;

    // 6. OAuth Provider Authorize & Callback Exchange
    const oauthUrlRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/auth/oauth/github/authorize?redirect_uri=http://localhost:3000/cb`,
      headers: { apikey: anonKey },
    });
    assert.equal(oauthUrlRes.statusCode, 200);
    const { state, authorizationUrl } = oauthUrlRes.json();
    assert.match(authorizationUrl, /github\.com\/login\/oauth\/authorize/);
    assert.ok(state);

    const oauthCbRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/oauth/github/callback`,
      headers: { apikey: anonKey },
      payload: {
        state,
        providerUserId: "gh_user_42",
        email: "oauth-dev@example.com",
        userMetadata: { handle: "octocat" },
      },
    });
    assert.equal(oauthCbRes.statusCode, 200);
    assert.equal(oauthCbRes.json().user.email, "oauth-dev@example.com");
    assert.ok(
      oauthCbRes
        .json()
        .user.identities.some(
          (i: any) => i.provider === "github" && i.provider_id === "gh_user_42"
        )
    );

    // 7. Admin bans Alice -> Alice's active JWT is immediately blocked
    const banRes = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slug}/auth/admin/users/${aliceId}`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: { status: "banned" },
    });
    assert.equal(banRes.statusCode, 200);

    const bannedProfileReq = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/auth/user`,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${aliceToken}`,
      },
    });
    assert.ok(
      bannedProfileReq.statusCode === 401 || bannedProfileReq.statusCode === 403
    );
  } finally {
    await app.close();
  }
});

test("Data API CRUD, filtering, pagination, foreign-key relationships, RPC, OpenAPI, and PostgreSQL Row-Level Security", async () => {
  const app = await buildApp();
  try {
    const opReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `rls-op-${Date.now()}@maary.dev`,
        password: "OperatorPass123!",
      },
    });
    const opToken = opReg.json().accessToken as string;

    const slug = `rls-data-${Date.now()}`;
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${opToken}` },
      payload: { name: "Data & RLS Project", slug },
    });
    const { anonKey, serviceRoleKey } = projRes.json().apiKeys;

    // 1. Create 'authors' and 'articles' tables with FK relationship and RLS enabled
    const createAuthors = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/tables`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "authors",
        enableRls: true,
        columns: [
          { name: "id", type: "uuid", primaryKey: true },
          { name: "display_name", type: "text", notNull: true },
        ],
      },
    });
    assert.equal(createAuthors.statusCode, 201);

    const createArticles = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/tables`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "articles",
        enableRls: true,
        columns: [
          {
            name: "id",
            type: "uuid",
            primaryKey: true,
            defaultValue: "gen_random_uuid()",
          },
          {
            name: "author_id",
            type: "uuid",
            notNull: true,
            references: {
              table: "authors",
              column: "id",
              onDelete: "CASCADE",
            },
          },
          { name: "title", type: "text", notNull: true },
          { name: "published", type: "boolean", defaultValue: "false" },
          { name: "views", type: "integer", defaultValue: "0" },
        ],
      },
    });
    assert.equal(createArticles.statusCode, 201);

    // 2. Define PostgreSQL RLS Policies on 'authors' and 'articles'
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/policies`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        tableName: "authors",
        policyName: "authors_public_read",
        command: "SELECT",
        usingExpression: "true",
      },
    });
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/policies`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        tableName: "authors",
        policyName: "authors_self_write",
        command: "ALL",
        usingExpression: "id = auth.uid()",
        checkExpression: "id = auth.uid()",
      },
    });
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/policies`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        tableName: "articles",
        policyName: "articles_visibility",
        command: "SELECT",
        usingExpression: "published = true OR author_id = auth.uid()",
      },
    });
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/policies`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        tableName: "articles",
        policyName: "articles_author_write",
        command: "ALL",
        usingExpression: "author_id = auth.uid()",
        checkExpression: "author_id = auth.uid()",
      },
    });

    // 3. Register two project users: Alice and Bob
    const aliceSignup = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: anonKey },
      payload: { email: "alice@blog.io", password: "Password123!" },
    });
    const aliceId = aliceSignup.json().user.id as string;
    const aliceJwt = aliceSignup.json().session.access_token as string;

    const bobSignup = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: anonKey },
      payload: { email: "bob@blog.io", password: "Password123!" },
    });
    const bobId = bobSignup.json().user.id as string;
    const bobJwt = bobSignup.json().session.access_token as string;

    // 4. Alice creates her author record and two articles (one published, one private draft)
    const aliceAuthorInsert = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/rest/authors`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: { id: aliceId, display_name: "Alice Writer" },
    });
    assert.equal(aliceAuthorInsert.statusCode, 201);

    const aliceArticlesInsert = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/rest/articles`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: [
        {
          author_id: aliceId,
          title: "Public Guide to Postgres",
          published: true,
          views: 150,
        },
        {
          author_id: aliceId,
          title: "Alice Secret Draft",
          published: false,
          views: 0,
        },
      ],
    });
    assert.equal(aliceArticlesInsert.statusCode, 201);
    assert.equal(aliceArticlesInsert.json().count, 2);

    // 5. Bob tries to impersonate Alice when inserting an article -> blocked by PostgreSQL RLS WITH CHECK!
    const bobForgedInsert = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/rest/articles`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
      payload: {
        author_id: aliceId,
        title: "Forged by Bob",
        published: true,
      },
    });
    assert.equal(bobForgedInsert.statusCode, 403);
    assert.equal(bobForgedInsert.json().error, "rls_policy_violation");

    // 6. Bob queries articles -> only sees Alice's published article, NOT Alice's draft!
    const bobReadRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/rest/articles?select=id,title,published,author:authors(id,display_name)&count=exact`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
    });
    assert.equal(bobReadRes.statusCode, 200);
    const bobRows = bobReadRes.json().data;
    assert.equal(bobRows.length, 1);
    assert.equal(bobReadRes.json().count, 1);
    assert.equal(bobRows[0].title, "Public Guide to Postgres");
    assert.equal(bobRows[0].author.display_name, "Alice Writer");

    // 7. Alice queries articles -> sees BOTH her published article AND her secret draft!
    const aliceReadRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/rest/articles?order=views.desc&count=exact`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
    });
    assert.equal(aliceReadRes.statusCode, 200);
    assert.equal(aliceReadRes.json().data.length, 2);
    assert.equal(aliceReadRes.json().count, 2);

    // 8. Reverse one-to-many relationship embedding (authors -> articles)
    const authorWithArticlesRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/rest/authors?id=eq.${aliceId}&select=id,display_name,articles(title,published)&single=true`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
    });
    assert.equal(authorWithArticlesRes.statusCode, 200);
    const authorObj = authorWithArticlesRes.json().data;
    assert.equal(authorObj.display_name, "Alice Writer");
    // Even inside the embedded subquery, RLS filters out Alice's unpublished draft for Bob!
    assert.equal(authorObj.articles.length, 1);
    assert.equal(authorObj.articles[0].title, "Public Guide to Postgres");

    // 9. service_role key bypasses RLS and sees all 2 articles
    const serviceReadRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/rest/articles`,
      headers: { apikey: serviceRoleKey },
    });
    assert.equal(serviceReadRes.statusCode, 200);
    assert.equal(serviceReadRes.json().data.length, 2);

    // 10. Create & invoke a PostgreSQL RPC function in the project schema
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/sql`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        sql: `CREATE OR REPLACE FUNCTION add_numbers(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + b; $$;`,
      },
    });

    const rpcRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/rpc/add_numbers`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
      payload: { a: 19, b: 23 },
    });
    assert.equal(rpcRes.statusCode, 200);
    assert.equal(rpcRes.json().data, 42);

    // 11. OpenAPI 3.1 Specification reflects project tables
    const openApiRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/openapi.json`,
      headers: { apikey: anonKey },
    });
    assert.equal(openApiRes.statusCode, 200);
    assert.equal(openApiRes.json().openapi, "3.1.0");
    assert.ok(openApiRes.json().components.schemas.authors);
    assert.ok(openApiRes.json().components.schemas.articles);
  } finally {
    await app.close();
  }
});
