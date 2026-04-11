(() => {
  const header = document.querySelector(".site-header");
  if (!header) {
    return;
  }

  let lastScrollY = window.scrollY;
  let ticking = false;

  function applyHeaderBehavior() {
    const currentScrollY = window.scrollY;

    if (currentScrollY <= 16) {
      header.classList.remove("site-header-hidden");
      lastScrollY = currentScrollY;
      ticking = false;
      return;
    }

    const delta = currentScrollY - lastScrollY;

    if (delta > 10 && currentScrollY > 96) {
      header.classList.add("site-header-hidden");
    } else if (delta < -6) {
      header.classList.remove("site-header-hidden");
    }

    lastScrollY = currentScrollY;
    ticking = false;
  }

  function requestHeaderUpdate() {
    if (ticking) {
      return;
    }
    ticking = true;
    requestAnimationFrame(applyHeaderBehavior);
  }

  window.addEventListener("scroll", requestHeaderUpdate, { passive: true });
  window.addEventListener("pageshow", () => {
    lastScrollY = window.scrollY;
    header.classList.remove("site-header-hidden");
    requestHeaderUpdate();
  });
  window.addEventListener("resize", () => {
    lastScrollY = window.scrollY;
    requestHeaderUpdate();
  });

  requestHeaderUpdate();
})();
