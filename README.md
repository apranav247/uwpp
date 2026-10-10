# Unified Workforce Productivity Platform (UWPP)

A multi-tenant, cloud-native productivity platform built to demonstrate Agile Development and DevOps practices.

Users can log in, belong to a single organization (tenant), manage projects, create tasks, assign tasks to teammates, update task statuses, receive notifications, and view team metrics.

## 1. Architecture

The application is built on a serverless AWS infrastructure:

- **Frontend**: React (built with Vite), utilizing AWS Amplify Auth. Served securely via a private Amazon S3 bucket behind an Amazon CloudFront distribution with Origin Access Control (OAC).
- **Authentication**: Amazon Cognito User Pool. Organization isolation is enforced via a custom attribute (`custom:orgId`) embedded in the JWT ID token.
- **API**: Amazon API Gateway HTTP API protected by a JWT Authorizer. It validates token signatures and audiences before passing requests to AWS Lambda.
- **Compute**: Node.js AWS Lambda functions (ES Modules, Node 22.x) handling projects, tasks, users, metrics, and notifications.
- **Database**: Single-table Amazon DynamoDB, utilizing on-demand billing. Keys are strictly derived from the `orgId` claim to guarantee structural tenant isolation.
- **Event-Driven Workflows**: Amazon EventBridge captures `TaskAssigned` events. A consumer Lambda processes these events, writes them to DynamoDB, and can optionally publish to an SNS topic.
- **Monitoring**: Explicit Amazon CloudWatch Log Groups with 7-day retention and a CloudWatch Alarm monitoring the Tasks Lambda for errors.

## 2. Security and Tenant Isolation

Security and multi-tenant data isolation are the core design priorities of UWPP.

- **Strict Identity Boundaries**: API Gateway explicitly requires an audience match. Access tokens are blocked natively (401 Unauthorized) because they lack the required app client audience claim.
- **Structural Data Isolation**: The `orgId` is extracted solely from the cryptographically verified JWT ID token. Handlers use this claim to construct DynamoDB Partition Keys (e.g., `ORG#<orgId>`). A user in Org A physically cannot query or address data belonging to Org B.
- **Immutable Organization Membership**: The `custom:orgId` attribute is written securely via Cognito Admin APIs during seeding. The Cognito App Client `WriteAttributes` explicitly excludes `custom:orgId`, meaning users cannot change their organization.
- **Automated Verification**: An exhaustive integration test (`tests/integration.js`) validates isolation. It proves that tampered tokens are rejected, unauthenticated access is denied, cross-tenant data requests return 404, cross-tenant assignee updates return 400, and no private data leaks across boundaries.

## 3. Setup and Deployment

UWPP utilizes a fully automated CI/CD pipeline using AWS CodePipeline, CodeBuild, AWS SAM (Serverless Application Model), and GitHub CodeConnections.

### Initial Setup
1. Clone the repository and connect it to a GitHub repository.
2. Ensure you have the AWS CLI, AWS SAM CLI, and Node.js (v22+) installed.
3. Deploy the pipeline stack first:
   ```bash
   sam deploy -t pipeline/pipeline.yaml --stack-name uwpp-pipeline --capabilities CAPABILITY_NAMED_IAM
   ```
4. Authenticate the AWS CodeConnections GitHub connection in the AWS Console.
5. Push to the `main` branch.

### Automated CI/CD
Once the pipeline is established, pushing code to the `main` branch triggers an automated build:
1. `npm test` runs all backend unit tests using Vitest.
2. `sam validate --lint` checks infrastructure definitions.
3. `sam build` bundles the Lambda functions (externalizing the AWS SDK v3 to prevent dynamic require issues).
4. `sam deploy` deploys the `uwpp-app` application stack.
5. The frontend is built against the newly deployed stack outputs.
6. The frontend artifact is synchronized to the private S3 bucket, and a CloudFront invalidation is triggered.

### Seeding Data
Run the seeding script to create organizations and users for testing:
```bash
$env:STACK_NAME="uwpp-app"
$s = Read-Host "Seed password" -AsSecureString; $env:SEED_PASSWORD = [System.Net.NetworkCredential]::new("",$s).Password
node scripts/seed.js
```

## 4. User Stories

| ID   | Story | Status |
|------|-------|--------|
| US1  | As a member I log in securely so that I only see my organization's data | Done |
| US2  | As an admin I have seeded organizations and users for demonstration | Done |
| US3  | As a member I create and view projects | Done |
| US4  | As a member I create tasks in a project | Done |
| US5  | As a member I assign a task to a teammate of my organization | Done |
| US6  | As a member I move a task between TODO, IN_PROGRESS, DONE | Done |
| US7  | As an assignee I get a notification when a task is assigned to me | Done |
| US8  | As a manager I see completion rate and tasks per person | Done |
| US9  | As a stakeholder I get proof that Org B cannot read Org A's data | Done |
| US10 | As a developer, a push to main deploys automatically | Done |
| US11 | As an operator I get retained logs and an alarm on errors | Done |

## 5. Sprint Review

The project was delivered across two agile sprints. The board URL is: `<board URL>`

**Sprint 1**: Focused on foundational infrastructure. Delivered the AWS SAM template, Cognito authentication, HTTP API, DynamoDB single-table design, CloudFront secure hosting, and the CI/CD CodePipeline. US1, US2, US3, US4, US5, US6, US10 were achieved.
**Sprint 2**: Focused on event-driven architecture, observability, and robust verification. Delivered the EventBridge notification consumer, Team Metrics endpoints, CloudWatch Error alarms, and a rigorous automated integration test script. US7, US8, US9, US11 were achieved.

## 6. Retrospective

- **What went well**: The serverless infrastructure-as-code approach with AWS SAM ensured environments were reproducible. The single-table DynamoDB design successfully enforced structural tenant isolation. The automated CodePipeline accelerated delivery and eliminated manual deployment errors.
- **What could be improved**: <to be confirmed by author>
- **Action items**: <to be confirmed by author>

## 7. Limitations and Future Work

### Limitations
- **Notifications**: Delivered via frontend polling rather than WebSockets/push. Read states are stored purely in browser local storage; there is no API endpoint to mark notifications as read.
- **Pagination**: While tasks are capped to prevent full-table scans, robust keyset pagination is not implemented in the frontend.
- **Metrics**: Team metrics are computed on-the-fly for every request. There is no caching layer, which may impact performance at high scale.
- **Error Alarming**: The CloudWatch alarm relies on the generic Lambda `Errors` metric (unhandled exceptions/timeouts), rather than catching explicitly handled API `5xx` responses.
- **IAM Policies**: CodeBuild execution roles require wildcard (`*`) resources for specific read actions (`logs:DescribeLogGroups`, `cloudwatch:DescribeAlarms`) and pipeline administration (`cognito-idp:*`, `cloudfront:*`) to support fully automated lifecycle management of CloudFront distributions and Cognito user pools.

### Future Work
- Implement WebSocket API Gateway for real-time push notifications.
- Implement robust token-based pagination across all list endpoints.
- Add an ElastiCache Redis or DynamoDB Streams-driven materialized view for team metrics caching.
- Shift to finer-grained CloudWatch Custom Metrics for alarming on logical HTTP 500 errors.

## 8. Demo Script

**Preparation:**
1. Ensure the `uwpp-app` stack is fully deployed.
2. Run `node scripts/seed.js` to create `OrgA` (User A, User B) and `OrgB` (User C).

**Execution:**
1. **Login & Authenticate**: Open the application in two separate incognito windows. Log into Window 1 as User A (`usera@example.com`) and Window 2 as User C (`userc@example.com`).
2. **Demonstrate Isolation**: In Window 1, create a project named "Alpha" and a task. Note that Window 2 (User C) cannot see "Alpha".
3. **Task Assignment**: In Window 1, assign the task to User B. Show that the dropdown only lists `OrgA` members.
4. **Notifications**: Log into a new window as User B. Show the EventBridge-driven notification arriving in the UI ("User A assigned you a task").
5. **Team Metrics**: Navigate to the metrics panel as User A. Show the completion rate and tasks-per-person update immediately as tasks are marked `DONE`.
6. **Security Audit**: Open a terminal and run `npm run integration` to prove all 36 security and tenant isolation rules pass automatically against the live infrastructure.

The project was delivered across two agile sprints. A project board URL is not included in this submission.

- **What could be improved**: Integration and deployment verification could be more automated. Notifications currently use polling, and pagination and monitoring could be enhanced.
- **Action items**: Add automated deployment smoke tests, implement notification pagination and improved delivery, and extend monitoring and alerting.
