//! The claim link as a terminal QR code, rendered exactly like the server's console one: two
//! modules per character cell, with a quiet zone, so a phone camera reads it off any terminal.

/// The QR for `url`, or nothing if it cannot be encoded (it always can: a claim link is short).
pub fn render(url: &str) -> String {
    qrcode::QrCode::new(url.as_bytes())
        .map(|code| {
            code.render::<qrcode::render::unicode::Dense1x2>()
                .quiet_zone(true)
                .build()
        })
        .unwrap_or_default()
}

/// What the person is told around the QR. The link is a one-time secret: it is shown on this
/// screen and never logged (the daemon prints it only to an interactive terminal).
pub fn claim_text(url: &str, window_minutes: u64) -> String {
    format!(
        "Unclaimed repeater. Within {window_minutes} minutes, scan this with your phone's camera, \
         or paste the link in streetCryptid (Settings > Repeaters):\n\n{}\n\n  {url}\n\n\
         The link is single-use. Do not post a picture of this code or paste the link anywhere.\n",
        render(url)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_code_with_the_link_beside_it() {
        let url = "https://streetcrypt.id/repeater#t=endpointticket&s=secret";
        let qr = render(url);
        assert!(qr.lines().count() > 10);
        let text = claim_text(url, 30);
        assert!(text.contains(url));
        assert!(text.contains("30 minutes"));
    }
}
