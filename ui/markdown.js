(() => {
  const parser = new commonmark.Parser();
  const renderer = new commonmark.HtmlRenderer({ safe: true });
  window.miganMarkdown = Object.freeze({
    render(target, source, onLink) {
      const value = String(source),
        documentAST = parser.parse(value.slice(0, 32000));
      const walker = documentAST.walker(),
        images = [];
      let event;
      while ((event = walker.next()))
        if (event.entering && event.node.type === "image")
          images.push(event.node);
      for (const image of images) {
        const text = new commonmark.Node("text");
        text.literal = "[gambar eksternal tidak dimuat otomatis]";
        image.insertBefore(text);
        image.unlink();
      }
      const fragment = DOMPurify.sanitize(renderer.render(documentAST), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: [
          "p",
          "br",
          "hr",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "strong",
          "em",
          "s",
          "blockquote",
          "ul",
          "ol",
          "li",
          "pre",
          "code",
          "a",
        ],
        ALLOWED_ATTR: ["href", "title", "class", "start"],
        ALLOW_DATA_ATTR: false,
      });
      for (const link of fragment.querySelectorAll("a")) {
        let url;
        try {
          url = new URL(link.getAttribute("href"));
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw Error();
        } catch {
          link.replaceWith(document.createTextNode(link.textContent));
          continue;
        }
        const address = url.href;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onLink?.(address);
        });
      }
      target.classList.add("markdown");
      target.replaceChildren(fragment);
      if (value.length > 32000)
        target.append(
          document.createTextNode(
            "\n[Preview dibatasi; jawaban lengkap ada di riwayat]",
          ),
        );
    },
  });
})();
