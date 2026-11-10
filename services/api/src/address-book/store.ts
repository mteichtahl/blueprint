import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';
import { newId } from '../workspace/model.ts';
import {
  cleanTags,
  ContactBody,
  CONTACTS_PK,
  contactSk,
  findDuplicate,
  type Contact,
} from './model.ts';

/** Storage for the shared contacts list, used by the address book and by events (crew). */

const table = () => env('MAIN_TABLE');

export async function allContacts(): Promise<Contact[]> {
  const items: Contact[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
        ExpressionAttributeValues: { ':pk': CONTACTS_PK, ':c': 'CONTACT#' },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...((res.Items ?? []) as Contact[]));
    start = res.LastEvaluatedKey;
  } while (start && items.length < 5000);
  return items;
}

export async function saveContact(c: Contact, condition?: 'new' | 'exists') {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: CONTACTS_PK, SK: contactSk(c.contactId), type: 'contact', ...c },
      ...(condition === 'new' ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      ...(condition === 'exists' ? { ConditionExpression: 'attribute_exists(PK)' } : {}),
    }),
  );
}

/** "Sam de Vries" → first "Sam", last "de Vries". */
export function splitName(name: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

export interface PersonIn {
  name: string;
  email: string;
  phone: string;
  /** Tag to make sure the contact carries, e.g. "Crew" or "Volunteer". */
  tag: string;
}

/**
 * Finds the person in contacts (by email, then phone) or adds them, and makes
 * sure they carry `tag`. Returns the contact and whether it was created.
 * `known` lets a caller resolve several people against one read of the list.
 */
export async function upsertPerson(
  p: PersonIn,
  by: { sub: string; role: 'artist' | 'bmg' },
  known: Contact[],
): Promise<{ contact: Contact; created: boolean }> {
  const existing = findDuplicate(known, { email: p.email, phone: p.phone });
  if (existing) {
    if (!existing.tags.some((t) => t.toLowerCase() === p.tag.toLowerCase())) {
      const tagged: Contact = {
        ...existing,
        tags: cleanTags([...existing.tags, p.tag]),
        updatedAt: new Date().toISOString(),
        updatedBy: by.sub,
      };
      await saveContact(tagged, 'exists');
      known.splice(known.indexOf(existing), 1, tagged);
      return { contact: tagged, created: false };
    }
    return { contact: existing, created: false };
  }
  const contact: Contact = {
    ...ContactBody.parse({ ...splitName(p.name), email: p.email, phone: p.phone, tags: [p.tag] }),
    contactId: newId(),
    createdBy: by.sub,
    createdByRole: by.role,
    createdAt: new Date().toISOString(),
  };
  await saveContact(contact, 'new');
  known.push(contact);
  return { contact, created: true };
}
