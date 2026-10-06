# SPEC.md - Unified Workforce Productivity Platform

SOURCE OF TRUTH. Antigravity reads this first in every phase.
If a prompt conflicts with this file, stop and tell the user. Do not silently choose.

## 1. Project summary
Multi-tenant, cloud-native productivity platform (M.Tech SE project: Agile Development Process and DevOps).
Users log in, belong to one organization, manage projects, create/assign tasks, update task status,
get a notification when a task is assigned to them, and see two metrics (completion rate; tasks per person).
Demonstrates: Agile process, AWS serverless, organization-level data isolation, event-driven design,
Infrastructure as Code (SAM), automated CI/CD (CodePipeline/CodeBuild), monitoring (CloudWatch).
Solo student, about 17 working hours. Priorities: WORKING > SIMPLE > DEMONSTRABLE > RELIABLE > extras.
A small real system beats a large simulated one.

## 2. Architecture and flows

Components:
  Browser (React on CloudFront + private S3 website) --SRP--> Cognito User Pool (ID token: sub, custom:orgId)
  Browser --Bearer ID token--> API Gateway HTTP API (JWT authorizer) --> Lambdas
  Lambdas (projects, tasks, users, notifications, metrics) --> DynamoDB single table
  tasks Lambda --PutEvents--> EventBridge default bus --rule--> notification consumer Lambda
  consumer --> DynamoDB (NOTIF item) --(optional)--> SNS topic --> email
  CloudWatch: log groups (7 days), one alarm on tasks Lambda Errors

Request flow:
  1 React gets ID token (Amplify fetchAuthSession)
  2 Request with "Authorization: Bearer <idToken>"
  3 API Gateway JWT authorizer validates signature, issuer, audience (client ID), expiry; invalid -> 401
  4 Lambda reads orgId = claims["custom:orgId"], userId = claims["sub"]; missing orgId -> 403
  5 Every DynamoDB key is built from that orgId
  6 JSON response; CORS handled by API Gateway only

Assignment event flow:
  PATCH /tasks/{taskId} {assignedTo}
  -> verify assignee item exists at ORG#<orgId>/USER#<assignedTo>
  -> UpdateItem task (condition attribute_exists(PK))
  -> PutEvents TaskAssigned (check FailedEntryCount)
  -> EventBridge rule -> consumer Lambda -> PutItem NOTIF
  -> optional SNS publish -> UI polls GET /notifications every 10-15 s

CI/CD flow:
  push to main -> GitHub -> CodePipeline (CodeConnections) -> CodeBuild:
  npm ci, vitest, sam build, sam deploy, read stack outputs, build frontend with VITE_ vars,
  aws s3 sync to the site bucket.
  pipeline/pipeline.yaml is a separate stack, deployed once by the user. Fallbacks in section 3.7.

Stacks: "uwpp-pipeline" (pipeline/pipeline.yaml, manual, once) and "uwpp-app" (template.yaml).

## 3. Locked technical decisions

3.1 Stack
- Frontend: React + Vite + JavaScript (no TypeScript).
- Backend: Node.js JavaScript, ES Modules only (package.json "type":"module"; never mix CommonJS), AWS SDK v3.
- Tests: Vitest + aws-sdk-client-mock. Bundling: SAM esbuild (Format esm, OutExtension .js=.mjs, Target node22, EntryPoints [index.js], External ["@aws-sdk/*"]).
- Lambda runtime: nodejs22.x. Region: ap-southeast-2. (Deviation: local Node is 24, Lambda and CodeBuild use 22, and we externalize AWS SDK v3 to avoid dynamic require errors).
- No samconfig.toml: deploy commands are npm scripts in root package.json; CodeBuild passes explicit flags.
- Lambda: 256 MB, 10 s timeout. DynamoDB: on-demand billing.

3.2 Auth (Cognito)
- One User Pool, one app client WITHOUT secret. UsernameAttributes=email. AdminCreateUserOnly=true (no self signup).
- Schema attribute: name "orgId", String, length 1-64, Mutable=true (appears as custom:orgId). Name is FINAL before first deploy.
- App client ReadAttributes: email, email_verified, custom:orgId. WriteAttributes: email only (users cannot set orgId).
- App client auth flows: ALLOW_USER_SRP_AUTH, ALLOW_REFRESH_TOKEN_AUTH, ALLOW_ADMIN_USER_PASSWORD_AUTH (test script, needs IAM
  credentials). ALLOW_USER_PASSWORD_AUTH only if Phase 0 shows admin auth is blocked; document as demo-only limitation.
- No Hosted UI. Frontend uses Amplify Auth v6 (aws-amplify/auth only): signIn, signOut, fetchAuthSession.
- Tokens are kept in browser storage by Amplify (demo limitation; XSS would expose them).

3.3 Token flow
- Frontend sends the ID TOKEN (not the access token): "Authorization: Bearer <idToken>".
- HTTP API JWT authorizer: issuer = https://cognito-idp.<region>.amazonaws.com/<userPoolId>, audience = [app client ID].
- Lambda: orgId = event.requestContext.authorizer.jwt.claims["custom:orgId"]; userId = claims["sub"].
- NEVER trust orgId from body, query string, path or headers. Missing/empty orgId claim -> 403.

3.4 Hosting and config
- React build on a PRIVATE S3 bucket (all public access blocked) served by CloudFront with Origin Access Control. Rule: the CloudFront distribution must NEVER reference the API (prevents a circular dependency). SPA fallback: CloudFront turns 403 and 404 into /index.html with status 200. The pipeline must create a CloudFront invalidation after uploading the frontend.
- Deterministic bucket name: uwpp-<AccountId>-<Region>-site (built with !Sub in template.yaml).
- CORS configured on the HTTP API only: AllowOrigins = [https://<distribution domain>, http://localhost:5173], methods GET,POST,PATCH,OPTIONS,
  headers Authorization,Content-Type. Lambdas do not set CORS headers.
- Frontend config: build step reads CloudFormation stack outputs and writes VITE_API_URL, VITE_USER_POOL_ID,
  VITE_USER_POOL_CLIENT_ID (frontend/.env.production, gitignored). No secrets in React, ever.

3.5 IAM
- Mode R (roles can be created): one scoped policy per function. Mode L (LabRole only): every function and CodeBuild/CodePipeline use
  the existing role passed as a template parameter. The mode is decided by Phase 0 and written in ENVIRONMENT FINDINGS. No fake roles.
- Reference minimum permissions (Mode R):
  projects: dynamodb Query, PutItem | tasks: GetItem, PutItem, UpdateItem, Query (table + index/GSI1), events:PutEvents |
  users: Query | notifications API: Query | consumer: PutItem, (sns:Publish) | metrics: Query.
  Resources are the table ARN (and its index ARN). No "*" unless unavoidable and justified here.

3.6 Monitoring
- Explicit AWS::Logs::LogGroup per Lambda, RetentionInDays 7, attached with the function LoggingConfig. (Rule: the explicit LogGroup is created in the SAME phase as the function, with no explicit LogGroupName).
- One CloudWatch alarm: Lambda Errors >= 1 over 60 s on the tasks function. No alarm action required.
- Never log tokens, the Authorization header or the full Lambda event. Log IDs and error messages only.

3.7 CI/CD
- pipeline/pipeline.yaml, deployed once by the user, separate from template.yaml.
- Preferred: GitHub -> CodePipeline -> CodeBuild (buildspec.yml). Fallback (a): CodeBuild project with GitHub source + webhook.
  Fallback (b): CodeBuild started manually from GitHub source. State the real option in ENVIRONMENT FINDINGS and README.
- Do NOT store AWS credentials as GitHub secrets. Do not claim a push triggers deployment unless it really does.
- Pipeline artifact bucket is created by pipeline.yaml; sam deploy uses --s3-bucket with it.

3.8 Forbidden
Repository/service/controller layers, interfaces, wrappers, extra utility files, Lambda layers, extra config files, extra docs files,
TypeScript, CommonJS, Scan operations in application code, fake AWS services in deployed code.

## 4. ENVIRONMENT FINDINGS (filled after Phase 0)
- Local: Windows / PowerShell | node 24.13.0 | npm 11.6.2 | git 2.55.0.windows.3 | sam installed | aws cli installed
- Region: ap-southeast-2
- Lambda runtime chosen (and others available): nodejs22.x
- IAM mode: Mode R (can create roles). Role name/ARN parameter: N/A
- CloudFormation/SAM deploy end to end: SUCCESS
- Cognito (custom attribute, ID token contains custom:orgId, admin auth flow works): SUCCESS (orgId and sub decoded correctly)
- HTTP API JWT authorizer (401 without token, 200 with token, claims visible in Lambda): SUCCESS
- DynamoDB / EventBridge rule -> Lambda / SNS email confirm / CloudWatch alarm: SUCCESS
- esbuild layout verdict (shared.js import + root package.json deps): SUCCESS (with External: ['@aws-sdk/*'] configuration to avoid 'node:https' dynamic require errors)
- S3 website: public hosting allowed? YES. Website URL format (exact pattern): http://<bucket-name>.s3-website-ap-southeast-2.amazonaws.com
- SRP in browser on plain HTTP S3 URL (window.isSecureContext, typeof crypto.subtle): window.isSecureContext is false, typeof crypto.subtle is undefined.
- CloudFront required: YES (Amplify SRP authentication requires crypto.subtle which requires a secure context / HTTPS).
- CodeBuild: OK | CodePipeline: OK | GitHub connection authorized: YES
- Pipeline option chosen: Preferred (GitHub -> CodePipeline -> CodeBuild via CodeConnections)
- Session behavior (credential lifetime, what persists after lab ends): N/A (Standard AWS Account)
- Limitations and deviations from this SPEC: We must use CloudFront to serve the S3 website because `crypto.subtle` is undefined over plain HTTP. We had to use Node.js 22.x and externalize the AWS SDK in esbuild to avoid dynamic require errors.
- Phase 1 Outputs: ApiUrl (https://teqfifz5k9.execute-api.ap-southeast-2.amazonaws.com), SiteUrl (https://daic6fejgu1s5.cloudfront.net), DistributionId (EJ0G99S9VL4VG).

## 5. DynamoDB schema (one table, NO Scan in application code)

Table: keys PK (S), SK (S). GSI1: GSI1PK (S), GSI1SK (S), projection ALL. On-demand.

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Organization | ORG#<orgId> | META | - | - |
| User | ORG#<orgId> | USER#<userId> (Cognito sub) | - | - |
| Project | ORG#<orgId> | PROJECT#<projectId> | - | - |
| Task | ORG#<orgId> | TASK#<taskId> | ORG#<orgId>#PROJECT#<projectId> | TASK#<taskId> |
| Notification | ORG#<orgId> | NOTIF#<userId>#<isoTimestamp>#<id> | - | - |

IDs: projectId and taskId = crypto.randomUUID(). Timestamps: ISO 8601 UTC strings.
Attributes (fixed names):
- ORG:    PK, SK, entityType="ORG", orgId, name, createdAt
- USER:   PK, SK, entityType="USER", userId, orgId, email, name, createdAt
- PROJECT:PK, SK, entityType="PROJECT", projectId, orgId, name, description, createdBy, createdAt
- TASK:   PK, SK, GSI1PK, GSI1SK, entityType="TASK", taskId, projectId, orgId, title, description, status (TODO|IN_PROGRESS|DONE),
          assignedTo (userId; absent if unassigned), createdBy, createdAt, updatedAt
- NOTIF:  PK, SK, entityType="NOTIFICATION", notificationId (= EventBridge event id), orgId, userId (recipient), type="TASK_ASSIGNED",
          taskId, projectId, title, message, assignedBy, createdAt (= detail.timestamp)

Access patterns:
- projects per org: Query PK=ORG#o, begins_with(SK,"PROJECT#")
- tasks per project: Query GSI1 GSI1PK=ORG#o#PROJECT#p
- one task: GetItem PK=ORG#o, SK=TASK#t
- all tasks per org (metrics): Query PK=ORG#o, begins_with(SK,"TASK#"), loop on LastEvaluatedKey
- users per org: Query PK=ORG#o, begins_with(SK,"USER#")
- notifications per user: Query PK=ORG#o, begins_with(SK,"NOTIF#<userId>#"), ScanIndexForward=false, Limit 50

DynamoDB rules: `status` and `name` are reserved words, so use ExpressionAttributeNames. Every UpdateItem has
ConditionExpression attribute_exists(PK); a failed condition means 404. List endpoints return at most 100 items.
Key builders live in shared.js so no handler hand-writes a key.

Isolation (viva wording): The organization ID comes only from the signed token, which Cognito issued and API Gateway verified.
Every DynamoDB read and write puts that ID in the partition key (ORG#<orgId>), and the GSI key also contains it.
So a user from Org B cannot even address Org A's data: there is no key they can build that points into Org A.
Asking for another org's task ID simply finds nothing (404). This is structural isolation, not an if-statement filter.
Honest limit: the DynamoDB table is shared, and isolation relies on correct key construction in code, which is why tests check it.

## 6. API contract (HTTP API, JWT authorizer on EVERY route)
All responses are JSON. Errors: {"error":"message"} with 400 (bad input), 403 (no orgId claim), 404, 500.
Also: 400 for non-UUID IDs, 400 for assignee not in organization, 404 for project not found, 404 for task not found.
Success: 200 (GET, PATCH) or 201 (POST). Collections are returned as {"items":[...]}.

- GET /projects                 -> items sorted by client
- POST /projects                body {name (1-100), description?} -> 201 project
- GET /tasks?projectId=<id>     projectId required (400 if missing) -> items of that project in caller's org
- POST /tasks                   body {projectId, title (1-200), description?}; project must exist in caller's org; status=TODO; NO assignedTo -> 201
- PATCH /tasks/{taskId}         body {status?, assignedTo?}; at least one; status in enum; assignedTo = userId in SAME org (else 400/404);
                                changing assignedTo emits TaskAssigned -> 200 updated task
- GET /users                    -> [{userId, name, email}] of caller's org
- GET /notifications            -> caller's notifications, newest first, max 50
- GET /metrics                  -> {totalTasks, doneTasks, completionRate (0-100, one decimal),
                                   tasksPerPerson:[{userId,name,total,done}], unassigned}
Task statuses: TODO, IN_PROGRESS, DONE.

## 7. Event schema (default event bus)
{ "source": "workforce.tasks", "detail-type": "TaskAssigned",
  "detail": { "taskId", "projectId", "organizationId", "assignedTo", "assignedBy", "title", "timestamp" } }
- organizationId comes from the JWT claim of the caller; assignedBy = caller's sub; timestamp = ISO string.
- Rule pattern matches source + detail-type. Consumer writes the NOTIF item under ORG#<detail.organizationId>,
  notificationId = EventBridge envelope "id" (idempotent on retries), optional SNS publish.
- Seeding: scripts/seed.js creates orgs OrgA (User A, User B) and OrgB (User C) with admin Cognito APIs
  (AdminCreateUser with MessageAction SUPPRESS, AdminSetUserPassword permanent, custom:orgId set), then writes ORG and USER items
  using the real Cognito sub. Idempotent (re-runnable). Passwords from env var SEED_PASSWORD or prompt, never in source or Git.
  Pool ID and table name are read from the stack outputs (stack name from env STACK_NAME).

## 8. Environment variables and outputs
Lambda env: TABLE_NAME (all), TOPIC_ARN (consumer, Phase 5 optional).
Stack outputs: ApiUrl, UserPoolId, UserPoolClientId, TableName, SiteBucketName, SiteUrl (https CloudFront URL), DistributionId.
Frontend build vars: VITE_API_URL, VITE_USER_POOL_ID, VITE_USER_POOL_CLIENT_ID.

## 9. Global rules for Antigravity
1. Read SPEC.md and inspect the existing project before changing anything; never assume files are empty.
2. Implement ONLY the current phase; never build future phases.
3. Do not recreate working files, refactor unrelated code, or remove working functionality.
4. Keep it simple; create the minimum files; reuse existing code. No forbidden items from section 3.8.
5. Never read, print, log or commit secrets, tokens or AWS credentials; never hard-code them; never log a full Lambda event.
6. No fake AWS integrations in application code; mocks only in unit tests.
7. Allowed locally: npm, vitest, sam build, sam validate --lint, git. NEVER run sam deploy, aws commands that change resources,
   or anything that deletes AWS resources. Prepare those commands for the user, who runs them and pastes output back.
   Present a short plan and wait for approval before any infrastructure change.
8. Never claim a deployment, test or pipeline run succeeded unless the output proves it; report failures honestly.
9. If an earlier phase is incomplete, report it and fix only what the current phase needs.
10. When the user must act in the AWS Console: say where to go, what to click, what value to enter, and what result to expect.
11. Locked decisions (sections 3, 5, 6, 7) never change silently. If one looks wrong, stop and tell the user.
12. After each successful phase update CURRENT PROJECT STATE and commit "phase-X: short description".

## 10. Agile plan
Board: GitHub Projects (columns Backlog, Sprint, In progress, Done). Every story is an issue with its phase label.
Sprint 1 (Day 1): Phases 0-3. Goal: authenticated, tenant-isolated backend deployed through an automated pipeline.
Sprint 2 (Day 2): Phases 4-7. Goal: usable product with notifications and metrics, proven isolation, demo ready.
Definition of Done: code works, tests pass, deployed (or deployable via pipeline), SPEC.md updated, committed.
Increments = commits "phase-X: ...". Sprint review + retrospective are written in README at the end of Phase 7.
User stories (also in README):
 US1 As a member I log in securely so that I only see my organization's data (P1, P4)
 US2 As an admin I have seeded organizations and users for demonstration (P1)
 US3 As a member I create and view projects (P2, P4)
 US4 As a member I create tasks in a project (P2, P4)
 US5 As a member I assign a task to a teammate of my organization (P2, P4)
 US6 As a member I move a task between TODO, IN_PROGRESS, DONE (P2, P4)
 US7 As an assignee I get a notification when a task is assigned to me (P5)
 US8 As a manager I see completion rate and tasks per person (P6)
 US9 As a stakeholder I get proof that Org B cannot read Org A's data (P2 unit tests, P7 integration test)
 US10 As a developer, a push to main deploys automatically (P3)
 US11 As an operator I get retained logs and an alarm on errors (P6)

## 11. Cut order if time runs out
KEEP: Cognito, isolation, DynamoDB, projects, tasks, assignment, EventBridge notification, CI/CD.
DROP in this order: SNS email, advanced styling, metrics UI, CloudWatch alarm, drag-and-drop.

## 12. CURRENT PROJECT STATE (update after every phase)
- Last completed phase: Phase 2
- Completed functionality: SAM foundation, Cognito, HTTP API JWT authorizer, DynamoDB table, CloudFront hosting, GET /users route. Seed script created. Projects and tasks creation, fetching, updating, and TaskAssigned event emission.
- AWS resources deployed: uwpp-app stack (Table, UserPool, UserPoolClient, HttpApi, UsersFunction, ProjectsFunction, TasksFunction, ProjectsLogGroup, TasksLogGroup, SiteBucket, SiteDistribution)
- Routes live:
  - /users
  - /projects
  - /tasks
  - /tasks/{taskId}
- Env vars / stack outputs: TABLE_NAME, ApiUrl, UserPoolId, UserPoolClientId, TableName, SiteBucketName, SiteUrl, DistributionId
- Deployment status: Deployed (uwpp-app)
- Known limitations: CloudFront required for HTTPS. Lambda requires Node.js 22.x and AWS SDK externalization. PutEvents failure after update returns 200, lists capped at 100, no unassign, no pagination on list endpoints.
- Next phase: Phase 3