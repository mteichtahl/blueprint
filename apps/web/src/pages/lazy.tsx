import { lazy, Suspense, type ComponentType } from 'react';
import { WaveLoader } from '../components/ui.tsx';

/*
 * Every screen behind the menu loads on first use, so opening the app only
 * downloads the home screen. Each one shows the wave loader while it arrives.
 * Screens that share code (Chat and Gigs, say) share a chunk.
 */

const loading = <WaveLoader />;

function page<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  return function LazyPage(props: P) {
    const Screen = Lazy as ComponentType<P>;
    return (
      <Suspense fallback={loading}>
        <Screen {...props} />
      </Suspense>
    );
  };
}

export { PlanStages, PlanTab } from './PlanLazy.tsx';

export const AccessPage = page(() => import('./Access.tsx').then((m) => m.AccessPage));
export const AssetLibrary = page(() => import('./Assets.tsx').then((m) => m.AssetLibrary));
export const BrandKit = page(() => import('./BrandKit.tsx').then((m) => m.BrandKit));
export const BmgConnectors = page(() => import('./Connectors.tsx').then((m) => m.BmgConnectors));
export const MyConnectors = page(() => import('./Connectors.tsx').then((m) => m.MyConnectors));
export const Contacts = page(() => import('./Contacts.tsx').then((m) => m.Contacts));
export const Events = page(() => import('./Events.tsx').then((m) => m.Events));
export const AllGigs = page(() => import('./Gigs.tsx').then((m) => m.AllGigs));
export const ArtistGigs = page(() => import('./Gigs.tsx').then((m) => m.ArtistGigs));
export const ArtistStats = page(() => import('./Insights.tsx').then((m) => m.ArtistStats));
export const Insights = page(() => import('./Insights.tsx').then((m) => m.Insights));
export const Invitations = page(() => import('./Invitations.tsx').then((m) => m.Invitations));
export const ArtistFiles = page(() => import('./Library.tsx').then((m) => m.ArtistFiles));
export const Library = page(() => import('./Library.tsx').then((m) => m.Library));
export const MeetingsPage = page(() => import('./Meetings.tsx').then((m) => m.MeetingsPage));
export const MyMeetings = page(() => import('./MyMeetings.tsx').then((m) => m.MyMeetings));
export const ArtistChats = page(() => import('./Messages.tsx').then((m) => m.ArtistChats));
export const BmgChat = page(() => import('./Messages.tsx').then((m) => m.BmgChat));
export const Newsroom = page(() => import('./Newsroom.tsx').then((m) => m.Newsroom));
export const Profile = page(() => import('./Profile.tsx').then((m) => m.Profile));
export const Prompts = page(() => import('./Prompts.tsx').then((m) => m.Prompts));
export const ArtistSubmissions = page(() =>
  import('./Review.tsx').then((m) => m.ArtistSubmissions),
);
export const ReviewQueue = page(() => import('./Review.tsx').then((m) => m.ReviewQueue));
export const AllTodos = page(() => import('./Todos.tsx').then((m) => m.AllTodos));
export const ArtistTodos = page(() => import('./Todos.tsx').then((m) => m.ArtistTodos));
export const Venues = page(() => import('./Venues.tsx').then((m) => m.Venues));
export const ArtistWorkspace = page(() => import('./Workspace.tsx').then((m) => m.ArtistWorkspace));
