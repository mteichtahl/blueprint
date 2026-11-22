/**
 * Realtime channel names (AppSync Events). A channel segment may hold only
 * letters, digits and dashes (up to 50), so an artist id's underscore
 * (`art_…`) becomes a dash; otherwise AppSync refuses the subscription with
 * "Invalid Channel Format". The web app (lib/realtime.ts) and the subscribe
 * rule (infra/lib/api-stack.ts) build the same name.
 */
export const artistChannel = (artistId: string): string =>
  `/inbox/artist-${artistId.split('_').join('-')}`;
