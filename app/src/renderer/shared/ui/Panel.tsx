import type { JSX, ComponentPropsWithRef } from 'react';
import styles from './Panel.module.scss';

export type PanelProps = ComponentPropsWithRef<'section'>;
export type PanelHeaderProps = ComponentPropsWithRef<'header'>;
export type PanelBodyProps = ComponentPropsWithRef<'div'>;
export type PanelActionsProps = ComponentPropsWithRef<'footer'>;

/** 데이터 상태를 갖지 않는 합성용 패널입니다. 크기 배치는 호출자가 정합니다. */
export function Panel({ className, ...props }: PanelProps): JSX.Element {
  return (
    <section
      {...props}
      className={[styles.panel, className].filter(Boolean).join(' ')}
    />
  );
}
/** 패널의 제목 영역에 네이티브 header 속성을 전달합니다. */
export function PanelHeader({
  className,
  ...props
}: PanelHeaderProps): JSX.Element {
  return (
    <header
      {...props}
      className={[styles.header, className].filter(Boolean).join(' ')}
    />
  );
}
/** 패널의 본문 영역에 네이티브 div 속성을 전달합니다. */
export function PanelBody({
  className,
  ...props
}: PanelBodyProps): JSX.Element {
  return (
    <div
      {...props}
      className={[styles.body, className].filter(Boolean).join(' ')}
    />
  );
}
/** 패널 하단의 동작 영역에 네이티브 footer 속성을 전달합니다. */
export function PanelActions({
  className,
  ...props
}: PanelActionsProps): JSX.Element {
  return (
    <footer
      {...props}
      className={[styles.actions, className].filter(Boolean).join(' ')}
    />
  );
}
