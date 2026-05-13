export function scrollTaskMessageIntoView(
  mount: HTMLElement,
  target: HTMLElement,
  onScrollTop?: (top: number) => void,
): void {
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  const messagesRect = messages.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const popover = mount.querySelector(".task-queue-popover") as HTMLElement | null;
  const popoverRect = popover?.getBoundingClientRect();
  const top = messagesRect.top + 12;
  let bottom = messagesRect.bottom - 12;
  if (
    popoverRect &&
    popoverRect.bottom > messagesRect.top &&
    popoverRect.top < messagesRect.bottom
  ) {
    bottom = Math.min(bottom, popoverRect.top - 14);
  }

  const visibleHeight = Math.max(80, bottom - top);
  const targetHeight = Math.min(targetRect.height, visibleHeight);
  const desiredTop = top + Math.max(8, (visibleHeight - targetHeight) / 2);
  const maxScrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
  messages.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, messages.scrollTop + targetRect.top - desiredTop),
  );
  onScrollTop?.(messages.scrollTop);
}
