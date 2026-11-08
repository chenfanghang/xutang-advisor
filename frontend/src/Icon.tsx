export type IconName =
  | "message"
  | "test"
  | "history"
  | "settings"
  | "arrow"
  | "check"
  | "eye"
  | "lock"
  | "connection"
  | "alert"
  | "copy";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    message:
      "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 1 1 21 11.5ZM7 9h8M7 13h5",
    test: "M8 3h8M10 3v6L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2l-6-10V3M8 14h8",
    history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2",
    settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
    arrow: "M5 12h14M13 6l6 6-6 6",
    check: "m5 12 4 4L19 6",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    lock: "M6 10h12v11H6ZM8 10V7a4 4 0 0 1 8 0v3",
    connection: "M9 3v4m6-4v4M7 7h10v3a5 5 0 0 1-10 0V7Zm5 8v6",
    alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v.1",
    copy: "M9 9h12v12H9ZM15 5V3H3v12h2",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
