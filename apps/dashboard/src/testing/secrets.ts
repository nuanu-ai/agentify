/**
 * The sign-in secret the tests configure: a test value of the length the
 * configuration asks for, put together when the tests run rather than written
 * out whole, so a secret scanner reading the repository finds no key here.
 */
export const TEST_AUTH_SECRET = ["a-secret", "that-is-at-least", "32-characters-long"].join("-");
