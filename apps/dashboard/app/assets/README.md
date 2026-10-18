# Google sign-in button

The dashboard draws its own "Sign in with Google" button, at the height, width
and corners of its other buttons. Google's
[sign-in branding guidelines](https://developers.google.com/identity/branding-guidelines#custom-button)
allow a custom button that keeps to their rules for it; the button keeps the
light theme's fill (#FFFFFF), 1 px stroke (#747775) and text colour (#1F1F1F),
the words "Sign in with Google" in Google Sans Medium at 14/20, and the
standard colour "G" on white at its own size, 10 px from the words.

`google-g.svg` is the "G" from Google's
[pre-approved branding assets](https://developers.google.com/static/identity/images/signin-assets.zip)
(Android + Web, light, square, without text), downloaded on 2026-10-18. Only
the root element is changed: its view box is cut to the 20 × 20 square the
"G" stands in, so the mark itself is untouched. It is drawn at 20 × 20 CSS
pixels, its size in Google's 40 px button.

`google-sans-500-sign-in.woff2` is Google Sans at weight 500, cut by Google
Fonts to the letters of "Sign in with Google", downloaded on 2026-10-18. It is
licensed under the SIL Open Font License 1.1, in `google-sans-OFL.txt`, which
reserves no font name. No remote font, image or Google script is loaded.
