import { describe, expect, it } from 'vitest';
import { pickAdminOrigin } from '../src/origin.ts';

describe('admin origin', () => {
  it('stays on the CloudFront address until the custom hosts are live', () => {
    expect(pickAdminOrigin('https://d1.cloudfront.net', 'https://admin.example.com')).toBe(
      'https://d1.cloudfront.net',
    );
  });
  it('uses the admin host once the app is on its own domain', () => {
    expect(pickAdminOrigin('https://artist.example.com', 'https://admin.example.com/')).toBe(
      'https://admin.example.com',
    );
  });
  it('falls back to the app address when no admin host is set', () => {
    expect(pickAdminOrigin('https://artist.example.com', undefined)).toBe(
      'https://artist.example.com',
    );
  });
});
