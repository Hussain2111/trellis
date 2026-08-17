import type { ReactElement } from 'react';
import type { Palette } from './palette';

/**
 * The slide template. This is a real, editable React component on purpose —
 * you will want to change how your slides look, and that should be a matter of
 * editing JSX rather than fighting a renderer.
 *
 * Rendered by satori, which supports a subset of CSS: flexbox only (no grid),
 * every element with more than one child needs an explicit `display: flex`, and
 * there is no cascade. Keep styles inline.
 */

export type SlideKind = 'hook' | 'body' | 'cta';

export interface SlideProps {
  kind: SlideKind;
  index: number;
  total: number;
  heading: string;
  body?: string;
  handle: string;
  palette: Palette;
  /** data: URI for a background image, when one was produced. */
  backgroundImage?: string;
}

const SIZE = 1080;

export function Slide(props: SlideProps): ReactElement {
  const { palette, kind } = props;
  const isHook = kind === 'hook';
  const isCta = kind === 'cta';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: SIZE,
        height: SIZE,
        padding: 88,
        position: 'relative',
        backgroundColor: palette.from,
        backgroundImage: props.backgroundImage
          ? `url(${props.backgroundImage})`
          : `linear-gradient(160deg, ${palette.from} 0%, ${palette.to} 100%)`,
        backgroundSize: `${SIZE}px ${SIZE}px`,
        fontFamily: 'Inter',
        color: palette.ink,
      }}
    >
      {/* A scrim keeps text legible over any background, including one from a
          service with no guarantees about what it returns. */}
      {props.backgroundImage ? (
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            top: 0,
            left: 0,
            width: SIZE,
            height: SIZE,
            backgroundColor: 'rgba(8,10,12,0.62)',
          }}
        />
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', width: 34, height: 3, backgroundColor: palette.accent }} />
        <div
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 22,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: palette.accent,
          }}
        >
          {isHook ? 'start here' : isCta ? 'your move' : `${props.index} / ${props.total}`}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          justifyContent: 'center',
          gap: 28,
        }}
      >
        <div
          style={{
            fontSize: isHook ? 92 : 62,
            fontWeight: 700,
            lineHeight: 1.06,
            letterSpacing: -2,
            maxWidth: 880,
          }}
        >
          {props.heading}
        </div>
        {props.body ? (
          <div
            style={{
              fontSize: isHook ? 34 : 36,
              lineHeight: 1.45,
              color: palette.muted,
              maxWidth: 820,
            }}
          >
            {props.body}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* One expression, not `@{handle}` — satori counts adjacent JSX text
            nodes as separate children and requires an explicit display. */}
        <div style={{ fontFamily: 'JetBrains Mono', fontSize: 24, color: palette.muted }}>
          {`@${props.handle}`}
        </div>
        {isCta ? null : (
          <div style={{ display: 'flex', gap: 8 }}>
            {Array.from({ length: props.total }, (_, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  width: i + 1 === props.index ? 26 : 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: i + 1 === props.index ? palette.accent : palette.muted,
                  opacity: i + 1 === props.index ? 1 : 0.35,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const SLIDE_SIZE = SIZE;
