// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoneBox, Field } from '../src/components/ui.tsx';
import { CreatedLine } from '../src/pages/Contacts.tsx';

afterEach(cleanup);

describe('Password fields', () => {
  it('show and hide what is typed with the eye button', () => {
    render(<Field label="Password" type="password" defaultValue="Secret#Pass123" />);
    const input = screen.getByLabelText('Password', { selector: 'input' });
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.getAttribute('type')).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('leaves other fields alone', () => {
    render(<Field label="Email" type="email" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('To-do tick box', () => {
  it('marks a to-do done without opening it', async () => {
    const onChange = vi.fn(async () => undefined);
    const open = vi.fn();
    render(
      <div onClick={open}>
        <DoneBox label="Book rehearsal room" done={false} onChange={onChange} />
      </div>,
    );
    const box = screen.getByRole('checkbox', { name: 'Mark “Book rehearsal room” done' });
    await act(async () => {
      fireEvent.click(box);
    });
    expect(onChange).toHaveBeenCalledWith(true);
    expect(open).not.toHaveBeenCalled();
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it('puts the tick back if saving fails', async () => {
    render(
      <DoneBox
        label="Send artwork"
        done={false}
        onChange={async () => {
          throw new Error('offline');
        }}
      />,
    );
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    await act(async () => {
      fireEvent.click(box);
    });
    expect(box.checked).toBe(false);
  });
});

describe('Date created', () => {
  it('shows the date and who added it', () => {
    render(<CreatedLine at="2026-11-03T02:00:00Z" byArtist={false} />);
    expect(screen.getByText(/Date created:/).textContent).toMatch(
      /Date created: 3 November 2026 · by Blueprint/,
    );
  });

  it('shows nothing without a date', () => {
    const { container } = render(<CreatedLine byArtist />);
    expect(container.textContent).toBe('');
  });
});
