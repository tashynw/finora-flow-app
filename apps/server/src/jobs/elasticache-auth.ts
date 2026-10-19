import {
  DescribeServerlessCachesCommand,
  DescribeUserGroupsCommand,
  ElastiCacheClient,
} from '@aws-sdk/client-elasticache';
import { buildQueryString, HttpRequest } from '@smithy/core/protocols';
import { Hash } from '@smithy/core/serde';
import { SignatureV4 } from '@smithy/signature-v4';

export type CacheTarget = {
  host: string;
  port: number;
  username: string;
  cacheName: string;
  region: string;
};

function awsCredentials() {
  const accessKeyId = process.env.ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'ACCESS_KEY_ID and SECRET_ACCESS_KEY are required to sign in to ElastiCache',
    );
  }
  return { accessKeyId, secretAccessKey };
}

function cacheNameFromHost(host: string): string {
  const label = host.split('.')[0] ?? host;
  const separator = label.lastIndexOf('-');
  return separator > 0 ? label.slice(0, separator) : label;
}

export async function createIamAuthToken(target: CacheTarget): Promise<string> {
  const signer = new SignatureV4({
    credentials: awsCredentials(),
    region: target.region,
    service: 'elasticache',
    sha256: Hash.bind(null, 'sha256'),
  });
  const cacheName = target.cacheName.toLowerCase();
  const signed = await signer.presign(
    new HttpRequest({
      method: 'GET',
      protocol: 'http:',
      hostname: cacheName,
      path: '/',
      headers: { host: cacheName },
      query: {
        Action: 'connect',
        User: target.username,
        ResourceType: 'ServerlessCache',
      },
    }),
    { expiresIn: 900 },
  );
  return `${signed.hostname}${signed.path}?${buildQueryString(signed.query ?? {})}`;
}

function awsRegion() {
  return process.env.AWS_REGION ?? 'us-east-2';
}

export async function resolveCacheTarget(): Promise<CacheTarget> {
  const configuredHost = process.env.REDIS_HOST;
  const configuredUser = process.env.REDIS_USERNAME ?? 'default.iam-user';
  if (configuredHost) {
    return {
      host: configuredHost,
      port: Number(process.env.REDIS_PORT ?? 6379),
      username: configuredUser,
      cacheName: cacheNameFromHost(configuredHost),
      region: awsRegion(),
    };
  }

  const client = new ElastiCacheClient({
    region: awsRegion(),
    credentials: awsCredentials(),
  });
  const listed = await client.send(new DescribeServerlessCachesCommand({}));
  const caches = listed.ServerlessCaches ?? [];
  const cache =
    caches.find((item) => item.Status === 'available') ?? caches[0];
  if (!cache?.Endpoint?.Address || !cache.ServerlessCacheName) {
    throw new Error(
      'No ElastiCache serverless cache is visible to ACCESS_KEY_ID. Set REDIS_HOST from the cache details page.',
    );
  }
  if (cache.ConnectionType === 'vpc') {
    throw new Error(
      `${cache.ServerlessCacheName} is only reachable inside its VPC. Create the cache with connection type Public to reach it from this PC.`,
    );
  }

  const userIds = cache.UserGroupId
    ? ((
        await client.send(
          new DescribeUserGroupsCommand({ UserGroupId: cache.UserGroupId }),
        )
      ).UserGroups?.[0]?.UserIds ?? [])
    : [];
  const username =
    configuredUser ??
    userIds.find((id) => id === 'default.iam-user') ??
    userIds.find((id) => id !== 'default') ??
    'default.iam-user';

  return {
    host: cache.Endpoint.Address,
    port: cache.Endpoint.Port ?? 6379,
    username,
    cacheName: cache.ServerlessCacheName.toLowerCase(),
    region: awsRegion(),
  };
}
