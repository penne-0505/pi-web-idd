/**
 * The screens the shell can show. The left rail switches between them, and a URL hash names them. Kept out of the
 * drawing layer on purpose: the generated parts draw whatever the view model hands them and know none of these
 * names, while the URL and the key map keep reading them.
 */
export type ViewName = "inbox" | "work" | "chat";
