/**
 * Edit-share sheet: how it prefills from a share (title, cover, description, nearest
 * expiry option) and what it sends to the server on save.
 */

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      textPrimary: '#eee',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
      red: '#e91429',
      inputBg: '#222',
    },
  }),
}));

jest.mock('../BottomSheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="bottom-sheet">{children}</View> : null,
  };
});

jest.mock('../CachedImage', () => ({ CachedImage: jest.fn(() => null) }));

jest.mock('../../services/subsonicService', () => ({ updateShare: jest.fn() }));

const mockFetchShares = jest.fn();
jest.mock('../../store/sharesStore', () => ({
  sharesStore: { getState: () => ({ fetchShares: mockFetchShares }) },
}));

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { EditShareSheet } from '../EditShareSheet';
import { CachedImage } from '../CachedImage';
import { updateShare } from '../../services/subsonicService';
import { editShareStore } from '../../store/editShareStore';

import type { Child, Share } from '../../services/subsonicService';

const mockCachedImage = CachedImage as unknown as jest.Mock;
const mockUpdateShare = updateShare as jest.Mock;

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

const OPTION_LABELS = ['Never', '1 day', '7 days', '30 days', '90 days', '1 year'];

function makeShare(overrides: Partial<Share> = {}): Share {
  return {
    id: 'sh1',
    url: 'https://example.test/share/sh1',
    username: 'user',
    created: new Date(NOW),
    visitCount: 0,
    ...overrides,
  };
}

const entry = (fields: Partial<Child>): Child => ({ id: 'e', ...fields }) as Child;

function open(share: Share) {
  act(() => editShareStore.getState().show(share));
}

function lastCoverProps() {
  const calls = mockCachedImage.mock.calls;
  return calls[calls.length - 1][0];
}

/** The selected chip renders its label in white; the rest in textPrimary. */
function selectedOption(): string[] {
  return OPTION_LABELS.filter((label) => {
    const style = [screen.getByText(label).props.style].flat(Infinity);
    return style.some((s) => s && s.color === '#fff');
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockUpdateShare.mockReset().mockResolvedValue(true);
  act(() => editShareStore.setState({ visible: false, share: null }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('header', () => {
  it('renders nothing while hidden', () => {
    render(<EditShareSheet />);
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  it('titles the share by its description when it has one', () => {
    open(makeShare({ description: 'Party mix', entry: [entry({ title: 'Song A' })] }));
    render(<EditShareSheet />);
    expect(screen.getByText('Edit Share')).toBeTruthy();
    expect(screen.getByText('Party mix')).toBeTruthy();
  });

  it("titles a single-entry share by the entry's title", () => {
    open(makeShare({ entry: [entry({ title: 'Song A', album: 'Album A' })] }));
    render(<EditShareSheet />);
    expect(screen.getByText('Song A')).toBeTruthy();
  });

  it('titles a multi-entry share by the first entry plus a count', () => {
    open(
      makeShare({
        entry: [entry({ title: 'Song A' }), entry({ id: 'b' }), entry({ id: 'c' })],
      }),
    );
    render(<EditShareSheet />);
    expect(screen.getByText('Song A + 2 more')).toBeTruthy();
  });

  it('falls back to the album name, then to "Shared items"', () => {
    open(makeShare({ entry: [entry({ album: 'Album A' })] }));
    const { unmount } = render(<EditShareSheet />);
    expect(screen.getByText('Album A')).toBeTruthy();
    unmount();

    open(makeShare({ entry: [entry({})] }));
    render(<EditShareSheet />);
    expect(screen.getByText('Shared items')).toBeTruthy();
  });

  it('titles a share with no entries "Share"', () => {
    open(makeShare({ entry: [] }));
    const { unmount } = render(<EditShareSheet />);
    expect(screen.getByText('Share')).toBeTruthy();
    unmount();

    open(makeShare());
    render(<EditShareSheet />);
    expect(screen.getByText('Share')).toBeTruthy();
  });

  it("shows the first entry's cover with its cover token and album id", () => {
    open(
      makeShare({
        entry: [
          entry({ title: 'A', coverArt: 'ca-1', albumId: 'al-1' }),
          entry({ id: 'b', coverArt: 'ca-2', albumId: 'al-2' }),
        ],
      }),
    );
    render(<EditShareSheet />);
    expect(lastCoverProps()).toEqual(
      expect.objectContaining({ coverArtId: 'ca-1', albumId: 'al-1', size: 150 }),
    );
  });

  it('resolves the cover from the album id alone when the entry has no cover token', () => {
    open(makeShare({ entry: [entry({ title: 'A', albumId: 'al-1' })] }));
    render(<EditShareSheet />);
    const props = lastCoverProps();
    expect(props.coverArtId).toBeUndefined();
    expect(props.albumId).toBe('al-1');
  });

  it('omits the cover when the first entry has neither, or there are no entries', () => {
    open(makeShare({ entry: [entry({ title: 'A' })] }));
    const { unmount } = render(<EditShareSheet />);
    unmount();
    open(makeShare());
    render(<EditShareSheet />);
    expect(mockCachedImage).not.toHaveBeenCalled();
  });
});

describe('prefill', () => {
  it("prefills the description and shows the placeholder when there is none", () => {
    open(makeShare({ description: 'Party mix' }));
    const { unmount } = render(<EditShareSheet />);
    expect(screen.getByPlaceholderText('Add a note...').props.value).toBe('Party mix');
    unmount();

    open(makeShare());
    render(<EditShareSheet />);
    expect(screen.getByPlaceholderText('Add a note...').props.value).toBe('');
  });

  it.each([
    ['no expiry', undefined, 'Never'],
    ['an unparseable expiry', 'not-a-date', 'Never'],
    ['an expiry in the past', new Date(NOW - DAY), 'Never'],
    ['about a day away', new Date(NOW + 1.2 * DAY), '1 day'],
    ['five days away', new Date(NOW + 5 * DAY), '7 days'],
    ['three weeks away (as a string)', new Date(NOW + 21 * DAY).toISOString(), '30 days'],
    ['four months away', new Date(NOW + 120 * DAY), '90 days'],
    ['ten months away', new Date(NOW + 300 * DAY), '1 year'],
  ])('preselects the nearest option for %s', (_label, expires, expected) => {
    open(makeShare({ expires: expires as Date | undefined }));
    render(<EditShareSheet />);
    expect(selectedOption()).toEqual([expected]);
  });
});

describe('saving', () => {
  it('sends the trimmed description and the chosen expiry, refreshes shares and closes', async () => {
    open(makeShare({ description: 'Old' }));
    render(<EditShareSheet />);

    fireEvent.changeText(screen.getByPlaceholderText('Add a note...'), '  New note  ');
    fireEvent.press(screen.getByText('7 days'));
    expect(selectedOption()).toEqual(['7 days']);

    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });

    expect(mockUpdateShare).toHaveBeenCalledWith('sh1', 'New note', NOW + 7 * DAY);
    expect(mockFetchShares).toHaveBeenCalledTimes(1);
    expect(editShareStore.getState()).toEqual(
      expect.objectContaining({ visible: false, share: null }),
    );
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  it('sends no expiry when "Never" is chosen', async () => {
    open(makeShare({ expires: new Date(NOW + 5 * DAY) }));
    render(<EditShareSheet />);

    fireEvent.press(screen.getByText('Never'));
    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });

    expect(mockUpdateShare).toHaveBeenCalledWith('sh1', '', undefined);
  });

  it('shows the busy state and locks the form while the update is in flight', async () => {
    const update = deferred<boolean>();
    mockUpdateShare.mockReturnValueOnce(update.promise);
    open(makeShare());
    render(<EditShareSheet />);

    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });

    expect(screen.queryByText('Save Changes')).toBeNull();
    expect(screen.getByPlaceholderText('Add a note...').props.editable).toBe(false);
    // Chips are disabled: pressing one does not change the selection.
    fireEvent.press(screen.getByText('1 year'));
    expect(selectedOption()).toEqual(['Never']);

    await act(async () => update.resolve(true));
    expect(editShareStore.getState().visible).toBe(false);
  });

  it('shows an error and stays open when the update fails', async () => {
    mockUpdateShare.mockResolvedValueOnce(false);
    open(makeShare({ description: 'Keep' }));
    render(<EditShareSheet />);

    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });

    expect(screen.getByText('Failed to update share.')).toBeTruthy();
    expect(mockFetchShares).not.toHaveBeenCalled();
    expect(editShareStore.getState().visible).toBe(true);
    // Saving is over, so the form is usable again.
    expect(screen.getByText('Save Changes')).toBeTruthy();
    expect(screen.getByPlaceholderText('Add a note...').props.editable).toBe(true);

    // A retry clears the error before trying again.
    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });
    expect(screen.queryByText('Failed to update share.')).toBeNull();
    expect(editShareStore.getState().visible).toBe(false);
  });

  it('does nothing when there is no share to save', async () => {
    act(() => editShareStore.setState({ visible: true, share: null }));
    render(<EditShareSheet />);

    await act(async () => {
      fireEvent.press(screen.getByText('Save Changes'));
    });
    expect(mockUpdateShare).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('closes without saving', () => {
    open(makeShare({ description: 'Unsaved' }));
    render(<EditShareSheet />);

    fireEvent.changeText(screen.getByPlaceholderText('Add a note...'), 'Edited');
    fireEvent.press(screen.getByText('Cancel'));

    expect(mockUpdateShare).not.toHaveBeenCalled();
    expect(editShareStore.getState().visible).toBe(false);
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  it('prefills afresh from the next share it opens', () => {
    open(makeShare({ description: 'First' }));
    render(<EditShareSheet />);
    fireEvent.changeText(screen.getByPlaceholderText('Add a note...'), 'Edited');
    fireEvent.press(screen.getByText('Cancel'));

    open(makeShare({ id: 'sh2', description: 'Second', expires: new Date(NOW + 30 * DAY) }));
    expect(screen.getByPlaceholderText('Add a note...').props.value).toBe('Second');
    expect(selectedOption()).toEqual(['30 days']);
  });
});
