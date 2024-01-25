export const splitTail = (input?: string, split = " ") => {
  if (!input) {
    return "";
  }
  const parts = input.split(split);
  return parts[parts.length - 1];
};

export const splitHead = (input?: string, split = " ") => {
  if (!input) {
    return "";
  }
  const parts = input.split(split);
  return parts[0];
};
