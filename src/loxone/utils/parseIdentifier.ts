export interface ParsedIdentifier {
  searchDescription: string;
  room: string;
  category: string;
  type: string;
  actionUuid: string;
}

export function parseIdentifier(identifier: string): ParsedIdentifier {
  const [searchDescription, typeQuery, actionUuid] = identifier.split(":");
  const [room, category] = searchDescription.split(" • ");
  const type = typeQuery?.split("=")[1] ?? "";
  return {
    searchDescription,
    room: room ?? "",
    category: category ?? "",
    type,
    actionUuid: actionUuid ?? "",
  };
}
