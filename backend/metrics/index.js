import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getAuth, json, orgPk, ddb, table } from '../shared.js';

export const handler = async (event) => {
  try {
    const auth = getAuth(event);
    if (!auth) return json(403, { error: 'Missing organization claim' });

    const pk = orgPk(auth.orgId);

    // Get all users
    let users = [];
    try {
      const usersRes = await ddb.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':sk': 'USER#'
        },
        Limit: 100
      }));
      users = usersRes.Items || [];
    } catch (err) {
      console.error(err.message);
      return json(500, { error: 'Internal error' });
    }

    const userMap = new Map();
    for (const u of users) {
      userMap.set(u.userId, { userId: u.userId, name: u.name, total: 0, done: 0 });
    }

    // Get all tasks
    let tasks = [];
    let exclusiveStartKey = undefined;
    let pages = 0;

    do {
      if (pages >= 50) {
        console.error("Metrics query exceeded 50 pages limit");
        return json(500, { error: 'Internal error' });
      }
      pages++;

      const tasksRes = await ddb.send(new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':sk': 'TASK#'
        },
        ProjectionExpression: '#s, assignedTo',
        ExpressionAttributeNames: { '#s': 'status' },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey
      }));

      for (const item of (tasksRes.Items || [])) {
        tasks.push(item);
      }
      exclusiveStartKey = tasksRes.LastEvaluatedKey;
    } while (exclusiveStartKey);

    let totalTasks = tasks.length;
    let doneTasks = 0;
    let unassigned = 0;
    let unknownUserTotal = 0;
    let unknownUserDone = 0;

    for (const task of tasks) {
      const isDone = task.status === 'DONE';
      if (isDone) doneTasks++;

      if (!task.assignedTo) {
        unassigned++;
      } else {
        const userStat = userMap.get(task.assignedTo);
        if (userStat) {
          userStat.total++;
          if (isDone) userStat.done++;
        } else {
          unknownUserTotal++;
          if (isDone) unknownUserDone++;
        }
      }
    }

    const completionRate = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 1000) / 10;

    const tasksPerPerson = Array.from(userMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (unknownUserTotal > 0) {
      tasksPerPerson.push({
        userId: 'unknown',
        name: 'Unknown user',
        total: unknownUserTotal,
        done: unknownUserDone
      });
    }

    return json(200, {
      totalTasks,
      doneTasks,
      completionRate,
      tasksPerPerson,
      unassigned
    });

  } catch (err) {
    console.error(err.message);
    return json(500, { error: 'Internal error' });
  }
};
