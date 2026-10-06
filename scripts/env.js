import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { writeFileSync } from 'fs';
import { join } from 'path';

const STACK_NAME = process.env.STACK_NAME || "uwpp-app";
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";

const cfn = new CloudFormationClient({ region: AWS_REGION });

const run = async () => {
    console.log(`Fetching outputs for stack: ${STACK_NAME}`);
    const stackRes = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    const outputs = stackRes.Stacks[0].Outputs;
    
    const apiUrl = outputs.find(o => o.OutputKey === 'ApiUrl').OutputValue;
    const poolId = outputs.find(o => o.OutputKey === 'UserPoolId').OutputValue;
    const clientId = outputs.find(o => o.OutputKey === 'UserPoolClientId').OutputValue;

    const envContent = `VITE_API_URL=${apiUrl}\nVITE_USER_POOL_ID=${poolId}\nVITE_USER_POOL_CLIENT_ID=${clientId}\n`;

    writeFileSync(join(process.cwd(), 'frontend', '.env.local'), envContent);
    writeFileSync(join(process.cwd(), 'frontend', '.env.production'), envContent);
    console.log("Wrote frontend/.env.local and frontend/.env.production");
};

run().catch(e => {
    console.error(e);
    process.exit(1);
});
