# Unified Workforce Productivity Platform (UWPP)

A multi-tenant, cloud-native productivity platform built to demonstrate Agile Development and DevOps practices.

Users can log in, belong to a single organization (tenant), manage projects, create tasks, assign tasks to teammates, update task statuses, receive notifications, and view team metrics.

## 1. Architecture

The application is built on a serverless AWS infrastructure:

- **Frontend:** React, built with Vite, using AWS Amplify Auth. The application is served through Amazon CloudFront from a private Amazon S3 bucket protected by Origin Access Control (OAC).
- **Authentication:** Amazon Cognito User Pool. Organization membership is represented by the custom `custom:orgId` attribute in the validated identity token.
- **API:** Amazon API Gateway HTTP API with a JWT authorizer that validates token signatures and configured audience claims.
- **Compute:** Node.js 22.x AWS Lambda functions using ES modules to handle users, projects, tasks, metrics, and notifications.
- **Database:** Amazon DynamoDB single-table design with on-demand billing. Organization-scoped partition keys are used to isolate tenant data.
- **Event-driven workflows:** Amazon EventBridge routes `TaskAssigned` events to a consumer Lambda. The consumer writes notifications to DynamoDB and can optionally publish to an Amazon SNS topic.
- **Monitoring:** CloudWatch log groups with seven-day retention and a CloudWatch alarm monitoring the Tasks Lambda `Errors` metric.
- **CI/CD:** AWS CodePipeline, CodeBuild, AWS SAM, and GitHub CodeConnections automate testing, building, and deployment.

## 2. Security and Tenant Isolation

Security and multi-tenant data isolation are core design priorities of UWPP.

- **Authentication:** Protected API endpoints require a valid JWT. Unauthenticated requests to the users, projects, notifications, and metrics endpoints returned HTTP `401` during verification.
- **Organization scoping:** Backend handlers derive organization scope from the validated identity claims and use organization-scoped DynamoDB partition keys, such as `ORG#<orgId>`, for data access.
- **Organization membership protection:** The `custom:orgId` attribute is configured through administrative Cognito operations during user seeding. The app client's `WriteAttributes` configuration excludes `custom:orgId`, preventing users from changing this attribute through the app client.
- **Cross-tenant isolation:** Integration tests verify that users cannot access another organization's private data through the tested API workflows.
- **Assignment validation:** The backend rejects assignment to a user who does not belong to the caller's organization. A cross-organization assignment attempt returned HTTP `400` during verification.
- **Token validation:** The integration tests cover invalid and tampered tokens. An access-token request returned HTTP `403` during testing because the required organization claim was unavailable to the backend. This documents the observed behavior and does not imply that API Gateway itself returned that response.
- **Automated verification:** The integration suite in `tests/integration.js` exercises authentication, tenant isolation, assignment validation, and cleanup against the deployed infrastructure.

## 3. Setup and Deployment

UWPP uses AWS SAM for infrastructure as code and AWS CodePipeline for automated deployment.

### Prerequisites

Install and configure:

- Node.js and npm
- AWS CLI
- AWS SAM CLI
- Git
- Access to an AWS account with the permissions required for deployment
- A GitHub repository and an authenticated AWS CodeConnections connection

### Initial Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/apranav247/uwpp.git
   cd uwpp
   ```

2. Install the root project dependencies:

   ```bash
   npm ci
   ```

3. Deploy the pipeline stack if it has not already been deployed:

   ```bash
   sam deploy -t pipeline/pipeline.yaml --stack-name uwpp-pipeline --capabilities CAPABILITY_NAMED_IAM
   ```

4. Complete the GitHub authorization for the AWS CodeConnections connection in the AWS Console.

5. Push changes to the `main` branch to trigger the pipeline.

**Note:** The commands above describe the initial pipeline setup. The existing deployed environment does not need to be redeployed manually for every code change.

### Automated CI/CD Workflow

A push to `main` triggers the configured pipeline:

1. Run backend unit tests using Vitest.
2. Validate the SAM infrastructure templates using `sam validate --lint`.
3. Build the Lambda functions using `sam build`.
4. Deploy the application stack using SAM.
5. Build the frontend using the deployed stack outputs.
6. Synchronize the frontend build to the private S3 bucket.
7. Invalidate CloudFront so that updated frontend assets can be served.

The pipeline reports its execution status in AWS CodePipeline.

### Seed Demonstration Data

The seeding script creates the demonstration users and organizations required for testing. Run it only in an environment where you are authorized to create these resources.

In PowerShell:

```powershell
$env:STACK_NAME = "uwpp-app"
$s = Read-Host "Seed password" -AsSecureString
$env:SEED_PASSWORD = [System.Net.NetworkCredential]::new("", $s).Password
node scripts/seed.js
Remove-Item Env:SEED_PASSWORD
```

Use the credentials configured for your own demonstration environment. Never commit passwords, tokens, or other secrets to the repository.

## 4. User Stories

| ID | User story | Status |
|---|---|---|
| US1 | As a member, I can log in securely and see only my organization's data. | Done |
| US2 | As an administrator, I can seed organizations and users for demonstration. | Done |
| US3 | As a member, I can create and view projects. | Done |
| US4 | As a member, I can create tasks within a project. | Done |
| US5 | As a member, I can assign tasks to teammates in my organization. | Done |
| US6 | As a member, I can move tasks between TODO, IN_PROGRESS, and DONE. | Done |
| US7 | As an assignee, I receive a notification when a task is assigned to me. | Done |
| US8 | As a manager, I can view completion rates and tasks per person. | Done |
| US9 | As a stakeholder, I can verify that one organization cannot read another organization's data. | Done |
| US10 | As a developer, I can trigger deployment by pushing to `main`. | Done |
| US11 | As an operator, I can access retained logs and a Lambda error alarm. | Done |

## 5. Sprint Review

The project was delivered across two agile sprints.

### Sprint 1 — Foundation and Core Workflows

The first sprint focused on infrastructure and core productivity features. It delivered the AWS SAM template, Cognito authentication, API Gateway, DynamoDB single-table design, secure CloudFront hosting, CI/CD pipeline, and project and task management workflows.

The sprint covered user stories US1–US6 and US10.

### Sprint 2 — Notifications, Observability, and Verification

The second sprint focused on event-driven processing, operational visibility, and automated verification. It delivered the EventBridge notification workflow, team metrics endpoint and frontend panel, CloudWatch logging and error alarm, and integration tests for authentication and tenant isolation.

The sprint covered user stories US7–US9 and US11.

A project board URL is not included in this submission.

## 6. Retrospective

- **What went well:** AWS SAM provided infrastructure as code, the DynamoDB partition-key design supported structural tenant isolation, and CodePipeline automated the build and deployment workflow. Unit and integration tests provided repeatable verification of important application behaviors.
- **What could be improved:** Integration and deployment checks could be more automated. Notifications currently use frontend polling, pagination is limited, and metrics are calculated on demand.
- **Action items:** Add automated post-deployment smoke tests, implement robust pagination and real-time notification delivery, and extend monitoring and alerting.

## 7. Limitations and Future Work

### Current Limitations

- **Notifications:** The frontend uses polling rather than WebSockets or another push-based mechanism. Notification seen-state is stored in browser local storage, and there is no backend API endpoint to mark notifications as read.
- **Pagination:** List endpoints have limits, but comprehensive keyset pagination is not implemented throughout the frontend.
- **Metrics:** Team metrics are calculated on demand for each request. No caching layer is currently used.
- **Error alarming:** The CloudWatch alarm monitors the Lambda `Errors` metric. It does not detect every handled HTTP `5xx` response, and an alarm state change does not automatically notify an operator unless an action is configured.
- **IAM policies:** Some CodeBuild permissions use wildcard resources for actions that require broader resource scope, including log-group and alarm discovery and parts of Cognito and CloudFront lifecycle management. These permissions should be reviewed and narrowed where supported.

### Future Work

- Introduce WebSocket-based or another push-based notification delivery mechanism.
- Implement robust token-based pagination across list endpoints.
- Cache or precompute team metrics for larger workloads.
- Add monitoring for application-level failures and configure notification actions for CloudWatch alarms.
- Further narrow IAM permissions and strengthen automated post-deployment verification.
- Improve notification delivery reliability and idempotency.

## 8. Demo Script

### Preparation

1. Confirm that the `uwpp-app` stack is deployed successfully.
2. Confirm that the frontend is available through CloudFront.
3. Ensure the seeded demonstration users are available and that you can authenticate with each account.
4. Open the frontend in separate browser sessions to avoid sharing authentication state.

### Demonstration

1. **Login and authentication:** Sign in as User A in one browser session and User C in another.
2. **Tenant isolation:** As User A, create a project named `Alpha` and a task. Show that User C cannot see User A's project or task.
3. **Task assignment:** As User A, assign the task to User B. Demonstrate that the assignment workflow restricts eligible assignees to the same organization.
4. **Notifications:** Sign in as User B in a separate session and demonstrate the assignment notification. Explain that the backend uses EventBridge and a consumer Lambda, while the frontend polls for updates.
5. **Team metrics:** As User A, show the metrics panel. Change a task's status to `DONE` and demonstrate the updated completion rate and per-person metrics.
6. **Automated verification:** Run the integration suite against the deployed environment:

   ```powershell
   npm run integration
   ```

   Show the test results and cleanup summary. The previously verified run passed 36 integration checks and completed cleanup successfully.
7. **CI/CD:** Show the latest successful CodePipeline execution for the submitted commit.
8. **Monitoring:** Show the Tasks Lambda CloudWatch alarm and its configuration. Explain that the alarm monitors Lambda errors and does not, by itself, prove that a real failure triggered an alert.

## 9. Verification Summary

The following results were recorded during project verification:

- **Unit tests:** 43 tests passed across 8 test files.
- **Integration tests:** 36 checks passed against the deployed infrastructure, including tenant-isolation and authentication scenarios.
- **Infrastructure validation:** `sam validate --lint` completed successfully.
- **Backend build:** `sam build` completed successfully.
- **Frontend build:** `npm run build` completed successfully.
- **Deployment:** The application and pipeline CloudFormation stacks were verified in `UPDATE_COMPLETE` state.
- **Endpoint health:** Unauthenticated requests to `/users`, `/projects`, `/notifications`, and `/metrics` returned HTTP `401`; the CloudFront frontend returned HTTP `200`.
- **Repository synchronization:** The final verified source revision was pushed to the GitHub `main` branch.

These results describe the checks actually recorded during development. They do not imply that every possible failure mode, scale limit, or alarm-notification path has been tested.

## 10. Conclusion

UWPP demonstrates a serverless, multi-tenant productivity application built with AWS services and supported by automated testing and CI/CD.

The project brings together authentication, organization-scoped data access, project and task management, event-driven notifications, team metrics, infrastructure as code, deployment automation, and operational monitoring. Its integration tests provide repeatable evidence for important tenant-isolation and authorization behaviors.

The identified limitations provide a roadmap for further improvements in scalability, notification delivery, pagination, and monitoring.