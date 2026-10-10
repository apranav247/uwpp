import { CognitoIdentityProviderClient, AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import https from 'node:https';

const STACK_NAME = process.env.STACK_NAME || "uwpp-app";
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";
const SEED_PASSWORD = process.env.SEED_PASSWORD;
const KEEP_DATA = process.env.KEEP_DATA === '1';

if (!SEED_PASSWORD || SEED_PASSWORD.length < 8) {
    console.error("SEED_PASSWORD env var is missing or too short.");
    process.exit(1);
}

const cfn = new CloudFormationClient({ region: AWS_REGION });
const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
const ddbClient = new DynamoDBClient({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient, { marshallOptions: { removeUndefinedValues: true } });

const state = {
    checks: [],
    createdItems: [] // { PK, SK } for cleanup
};

function record(id, desc, pass, error = '') {
    state.checks.push({ id, desc, pass, error });
    console.log(`[${id}] ${pass ? 'PASS' : 'FAIL'} - ${desc} ${error ? `(${error})` : ''}`);
}

async function fetchHelper(url, options = {}) {
    try {
        const res = await fetch(url, options);
        let body = null;
        const text = await res.text();
        if (text) {
            try { body = JSON.parse(text); } catch (e) { body = text; }
        }
        return { status: res.status, body, headers: res.headers };
    } catch (e) {
        return { status: 0, error: e.message };
    }
}

async function getTokens(userPoolId, clientId, username, password) {
    const res = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        AuthFlow: 'ADMIN_NO_SRP_AUTH',
        AuthParameters: {
            USERNAME: username,
            PASSWORD: password
        }
    }));
    return {
        idToken: res.AuthenticationResult.IdToken,
        accessToken: res.AuthenticationResult.AccessToken
    };
}

const run = async () => {
    console.log(`Fetching stack outputs for ${STACK_NAME}...`);
    const stackRes = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    const outputs = stackRes.Stacks[0].Outputs;

    const getOutput = key => {
        const out = outputs.find(o => o.OutputKey === key);
        return out ? out.OutputValue : null;
    };

    const apiUrl = getOutput('ApiUrl');
    const userPoolId = getOutput('UserPoolId');
    const clientId = getOutput('UserPoolClientId');
    const siteUrl = getOutput('SiteUrl');
    const bucketName = getOutput('SiteBucketName');
    const tableName = getOutput('TableName');

    if (!apiUrl || !userPoolId || !clientId || !siteUrl || !bucketName || !tableName) {
        throw new Error("Missing required stack outputs");
    }

    console.log("Authenticating test users...");
    const tokensA = await getTokens(userPoolId, clientId, 'usera@example.com', SEED_PASSWORD);
    const tokensB = await getTokens(userPoolId, clientId, 'userb@example.com', SEED_PASSWORD);
    const tokensC = await getTokens(userPoolId, clientId, 'userc@example.com', SEED_PASSWORD);

    const apiCall = async (path, method = 'GET', token = null, body = null, extraHeaders = {}) => {
        const headers = { ...extraHeaders };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (body) headers['Content-Type'] = 'application/json';

        return fetchHelper(`${apiUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null
        });
    };

    // Resolve user IDs
    const usersARes = await apiCall('/users', 'GET', tokensA.idToken);
    const usersCRes = await apiCall('/users', 'GET', tokensC.idToken);
    const userIdA = usersARes.body.items.find(u => u.email === 'usera@example.com').userId;
    const userIdB = usersARes.body.items.find(u => u.email === 'userb@example.com').userId;
    const userIdC = usersCRes.body.items.find(u => u.email === 'userc@example.com').userId;

    // Baseline metrics
    const baselineA = (await apiCall('/metrics', 'GET', tokensA.idToken)).body;
    const baselineC = (await apiCall('/metrics', 'GET', tokensC.idToken)).body;

    const expectStatus = async (id, desc, fn, expectedStatus) => {
        try {
            const res = await fn();
            if (res.status === expectedStatus) {
                record(id, desc, true);
                return res;
            } else {
                record(id, desc, false, `Expected ${expectedStatus}, got ${res.status}`);
                return res;
            }
        } catch (e) {
            record(id, desc, false, `Exception: ${e.message}`);
            return { status: 0 };
        }
    };

    // A1
    await expectStatus('A1', 'no Auth on /users', () => apiCall('/users', 'GET'), 401);
    await expectStatus('A1', 'no Auth on /projects', () => apiCall('/projects', 'GET'), 401);
    await expectStatus('A1', 'no Auth on /tasks', () => apiCall('/tasks?projectId=00000000-0000-0000-0000-000000000000', 'GET'), 401);
    await expectStatus('A1', 'no Auth on /notifications', () => apiCall('/notifications', 'GET'), 401);
    await expectStatus('A1', 'no Auth on /metrics', () => apiCall('/metrics', 'GET'), 401);

    // A2
    await expectStatus('A2', 'malformed token', () => apiCall('/projects', 'GET', 'not-a-jwt'), 401);

    // A3
    const parts = tokensC.idToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    payload['custom:orgId'] = 'orga';
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '')}.${parts[2]}`;
    await expectStatus('A3', 'tampered token', () => apiCall('/projects', 'GET', tampered), 401);

    // A4
    const resA4 = await apiCall('/projects', 'GET', tokensA.accessToken);
    if (resA4.status !== 200) {
        record('A4', `access token rejected with code ${resA4.status}`, true);
    } else {
        record('A4', 'access token', false, 'Expected NOT 200, got 200');
    }

    // ISOLATION Setup
    const projName = `IT-${Date.now()}`;
    const pRes = await expectStatus('SETUP', 'Create Project', () => apiCall('/projects', 'POST', tokensA.idToken, { name: projName }), 201);
    const projId = pRes.body.projectId;
    state.createdItems.push({ PK: 'ORG#orga', SK: `PROJECT#${projId}` });

    const t1Res = await expectStatus('SETUP', 'Create Task 1', () => apiCall('/tasks', 'POST', tokensA.idToken, { projectId: projId, title: "Task 1" }), 201);
    const taskId1 = t1Res.body.taskId;
    state.createdItems.push({ PK: 'ORG#orga', SK: `TASK#${taskId1}` });

    const t2Res = await expectStatus('SETUP', 'Create Task 2', () => apiCall('/tasks', 'POST', tokensA.idToken, { projectId: projId, title: "Task 2" }), 201);
    const taskId2 = t2Res.body.taskId;
    state.createdItems.push({ PK: 'ORG#orga', SK: `TASK#${taskId2}` });

    // I1
    const pA = await apiCall('/projects', 'GET', tokensA.idToken);
    const pC = await apiCall('/projects', 'GET', tokensC.idToken);
    const hasA = pA.body.items.some(p => p.projectId === projId);
    const hasC = pC.body.items.some(p => p.projectId === projId);
    record('I1', 'Project isolation', hasA && !hasC, !hasA ? 'User A missing project' : (hasC ? 'User C sees project' : ''));

    // I2
    const tC = await apiCall(`/tasks?projectId=${projId}`, 'GET', tokensC.idToken);
    record('I2', 'Task query isolation', tC.status === 200 && tC.body.items.length === 0, `Status: ${tC.status}, len: ${tC.body?.items?.length}`);

    // I3
    await expectStatus('I3', 'Task update isolation', () => apiCall(`/tasks/${taskId1}`, 'PATCH', tokensC.idToken, { status: "DONE" }), 404);
    const tA = await apiCall(`/tasks?projectId=${projId}`, 'GET', tokensA.idToken);
    const tA1 = tA.body.items.find(t => t.taskId === taskId1);
    record('I3', 'Task unmodified', tA1?.status === "TODO", `Status is ${tA1?.status}`);

    // I4
    await expectStatus('I4', 'Task create isolation', () => apiCall('/tasks', 'POST', tokensC.idToken, { projectId: projId, title: "x" }), 404);

    // I5
    await expectStatus('I5', 'Assignee isolation', () => apiCall(`/tasks/${taskId1}`, 'PATCH', tokensA.idToken, { assignedTo: userIdC }), 400);

    // I6
    const uA = await apiCall('/users', 'GET', tokensA.idToken);
    const uC = await apiCall('/users', 'GET', tokensC.idToken);
    const uCOnlyC = uC.body.items.length === 1 && uC.body.items[0].userId === userIdC;
    const uAHasAB = uA.body.items.length === 2 && !uA.body.items.some(u => u.userId === userIdC);
    record('I6', 'User query isolation', uCOnlyC && uAHasAB);

    // I7
    const pC2 = await apiCall('/projects?orgId=orga', 'GET', tokensC.idToken);
    const matchPC = JSON.stringify(pC.body) === JSON.stringify(pC2.body);
    const pC3 = await apiCall('/projects', 'POST', tokensC.idToken, { name: "IT-x", orgId: "orga" });
    const cProjId = pC3.body?.projectId;
    if (cProjId) state.createdItems.push({ PK: 'ORG#orgb', SK: `PROJECT#${cProjId}` });
    const pA3 = await apiCall('/projects', 'GET', tokensA.idToken);
    const pC4 = await apiCall('/projects', 'GET', tokensC.idToken);
    const aSeesC = pA3.body?.items?.some(p => p.projectId === cProjId);
    const cSeesC = pC4.body?.items?.some(p => p.projectId === cProjId);
    record('I7', 'Query string orgId isolation', matchPC && pC3.status === 201 && !aSeesC && cSeesC);

    // I8
    const mC = await apiCall('/metrics?orgId=orga', 'GET', tokensC.idToken);
    record('I8', 'Metrics query isolation', JSON.stringify(mC.body) === JSON.stringify(baselineC));

    // VALIDATION
    await expectStatus('V1', 'PATCH non-UUID', () => apiCall('/tasks/not-uuid', 'PATCH', tokensA.idToken, { status: "DONE" }), 400);
    await expectStatus('V2', 'GET tasks no projectId', () => apiCall('/tasks', 'GET', tokensA.idToken), 400);
    await expectStatus('V3', 'PATCH invalid status', () => apiCall(`/tasks/${taskId1}`, 'PATCH', tokensA.idToken, { status: "INVALID" }), 400);
    await expectStatus('V4', 'PATCH empty body', () => apiCall(`/tasks/${taskId1}`, 'PATCH', tokensA.idToken, {}), 400);
    await expectStatus('V5', 'POST project empty name', () => apiCall('/projects', 'POST', tokensA.idToken, { name: "" }), 400);

    // NOTIFICATIONS
    const nStart = Date.now();
    await expectStatus('N1', 'Assign task', () => apiCall(`/tasks/${taskId1}`, 'PATCH', tokensA.idToken, { assignedTo: userIdB }), 200);

    let foundNotif = null;
    let attempts = 0;
    while (attempts < 15) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        const res = await apiCall('/notifications', 'GET', tokensB.idToken);
        const notifs = res.body?.items?.filter(n => n.taskId === taskId1) || [];
        if (notifs.length === 1) {
            foundNotif = notifs[0];
            state.createdItems.push({ PK: 'ORG#orga', SK: `NOTIF#${userIdB}#${foundNotif.createdAt}#${foundNotif.notificationId}` });
            break;
        } else if (notifs.length > 1) {
            foundNotif = "DUPLICATE";
            break;
        }
    }
    const delay = ((Date.now() - nStart) / 1000).toFixed(1);
    record('N1', 'Notification delivery', foundNotif && foundNotif !== "DUPLICATE", `Delay: ${delay}s`);

    await apiCall(`/tasks/${taskId1}`, 'PATCH', tokensA.idToken, { assignedTo: userIdB });
    await new Promise(r => setTimeout(r, 6000));
    const nResB = await apiCall('/notifications', 'GET', tokensB.idToken);
    const nBCount = nResB.body?.items?.filter(n => n.taskId === taskId1).length;
    record('N2', 'Notification idempotent', nBCount === 1, `Count: ${nBCount}`);

    const nResA = await apiCall('/notifications', 'GET', tokensA.idToken);
    record('N3', 'Notification isolation A', !nResA.body?.items?.some(n => n.taskId === taskId1));

    // I9 (Delayed till after N1)
    const nResC = await apiCall('/notifications', 'GET', tokensC.idToken);
    record('I9', 'Notification isolation C', !nResC.body?.items?.some(n => n.taskId === taskId1));

    // METRICS
    const mA = (await apiCall('/metrics', 'GET', tokensA.idToken)).body;
    const m1Pass = mA.totalTasks === baselineA.totalTasks + 2 &&
                   mA.tasksPerPerson.reduce((a, b) => a + b.total, 0) + mA.unassigned === mA.totalTasks &&
                   mA.completionRate === (mA.totalTasks ? Math.round((mA.doneTasks / mA.totalTasks) * 1000) / 10 : 0);
    record('M1', 'Metrics total update', m1Pass);

    await apiCall(`/tasks/${taskId2}`, 'PATCH', tokensA.idToken, { status: "DONE" });
    const mA2 = (await apiCall('/metrics', 'GET', tokensA.idToken)).body;
    record('M2', 'Metrics done update', mA2.doneTasks === mA.doneTasks + 1);

    // CORS
    const reqOrigin = siteUrl.replace(/\/$/, "");

    const httpsReq = (url, opts) => new Promise((resolve) => {
        const req = https.request(url, opts, (res) => {
            res.on('error', () => {});
            res.on('aborted', () => {});
            res.resume();
            resolve({ status: res.statusCode, headers: res.headers });
        });
        req.on('error', () => resolve({ status: 0 }));
        req.end();
    });

    const parsedApiUrl = new URL(apiUrl);
    const corsOpts = {
        method: 'OPTIONS',
        headers: {
            'Origin': reqOrigin,
            'Access-Control-Request-Method': 'GET'
        }
    };

    const c1 = await httpsReq(`${apiUrl}/projects`, corsOpts);
    record('C1', 'Valid Origin preflight', c1.headers['access-control-allow-origin'] === reqOrigin);

    corsOpts.headers['Origin'] = 'https://evil.example';
    const c2 = await httpsReq(`${apiUrl}/projects`, corsOpts);
    record('C2', 'Invalid Origin preflight', c2.headers['access-control-allow-origin'] !== 'https://evil.example');

    // HOSTING
    const h1 = await fetchHelper(siteUrl);
    record('H1', 'CloudFront HTTPS access', h1.status === 200 && (h1.body?.includes('<div id="root"') || String(h1.body).includes('id="root"')));

    const h2Url = `https://${bucketName}.s3.${AWS_REGION}.amazonaws.com/index.html`;
    const h2 = await fetchHelper(h2Url);
    record('H2', 'Direct S3 block', h2.status === 403, `Got ${h2.status}`);

    // SUMMARY
    console.log("\n--- SUMMARY ---");
    let fails = 0;
    state.checks.forEach(c => {
        console.log(`${c.id}: ${c.pass ? 'PASS' : 'FAIL'} - ${c.desc}`);
        if (!c.pass) fails++;
    });
    console.log(`TOTAL: ${state.checks.length} | PASS: ${state.checks.length - fails} | FAIL: ${fails}`);

    // CLEANUP
    if (!KEEP_DATA) {
        console.log(`\nCleaning up ${state.createdItems.length} items...`);
        let delCount = 0;
        for (const item of state.createdItems) {
            try {
                await ddb.send(new DeleteCommand({
                    TableName: tableName,
                    Key: item
                }));
                delCount++;
            } catch (e) {
                console.error(`Failed to delete ${item.PK} ${item.SK}: [${e.name}] ${e.message}`);
            }
        }
        console.log(`Deleted ${delCount} items.`);

        const finalA = (await apiCall('/metrics', 'GET', tokensA.idToken)).body;
        const finalC = (await apiCall('/metrics', 'GET', tokensC.idToken)).body;

        const x1 = JSON.stringify(finalA) === JSON.stringify(baselineA);
        const x2 = JSON.stringify(finalC) === JSON.stringify(baselineC);
        record('X1', 'Metrics restored User A', x1);
        record('X2', 'Metrics restored User C', x2);

        console.log(`X1: ${x1 ? 'PASS' : 'FAIL'} - Metrics restored User A`);
        console.log(`X2: ${x2 ? 'PASS' : 'FAIL'} - Metrics restored User C`);

        if (!x1 || !x2) fails++;
    }

    if (fails > 0) process.exit(1);
};

run().catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
});
