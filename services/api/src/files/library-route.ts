import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * The library is one proxy route (rev 10, to keep the API stack small):
 * `/library/{proxy+}`. This maps it back to the route templates below, so
 * every library route behaves exactly as when it had its own resource.
 */
export function libraryRoute(event: APIGatewayProxyEvent): APIGatewayProxyEvent {
  if (event.resource !== '/library/{proxy+}') return event;
  const parts = (event.pathParameters?.proxy ?? '').split('/').filter(Boolean);
  const params = { ...(event.pathParameters ?? {}) };
  delete params.proxy;
  let resource = '/library/unknown';
  if (parts[0] === 'folders') {
    resource = parts.length > 1 ? '/library/folders/{proxy+}' : '/library/folders';
    if (parts.length > 1) params.proxy = parts.slice(1).join('/');
  } else if (parts[0] === 'files') {
    if (parts.length === 1) resource = '/library/files';
    else {
      params.fileId = parts[1]!;
      if (parts.length === 2) resource = '/library/files/{fileId}';
      else if (parts.length === 3 && (parts[2] === 'versions' || parts[2] === 'download')) {
        resource = `/library/files/{fileId}/${parts[2]}`;
      }
    }
  }
  return { ...event, resource, pathParameters: params };
}
