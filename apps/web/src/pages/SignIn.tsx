import { Button, Card, Wordmark } from '../components/ui.tsx';

export function SignIn({ onSignIn, signedOut }: { onSignIn: () => void; signedOut: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center bg-primary p-6">
      <Card className="w-full max-w-sm text-center">
        <Wordmark />
        <h1 className="mt-6 font-title text-3xl">Welcome to Blueprint</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {signedOut
            ? 'You have signed out.'
            : 'Sign in with a passkey, or your email and password.'}
        </p>
        <Button variant="cta" className="mt-6 w-full" onClick={onSignIn}>
          Sign in
        </Button>
        <p className="mt-4 text-xs text-muted-foreground">Accounts are by invitation only.</p>
      </Card>
    </main>
  );
}
