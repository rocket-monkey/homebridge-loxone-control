export function toPositive(n: number) {
  if (n < 0) {
    n = n * -1;
  }
  return n;
}
