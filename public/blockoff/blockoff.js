const revealItems = document.querySelectorAll(".reveal");
const glow = document.querySelector(".cursor-glow");
const waitlistModal = document.querySelector("[data-waitlist-modal]");
const waitlistForm = document.querySelector("[data-waitlist-form]");
const formStatus = document.querySelector("[data-form-status]");
const waitlistIntent = waitlistForm?.querySelector('input[name="intent"]');
const priceAnimation = document.querySelector("[data-price-animation]");

const SUPABASE_REST_URL = "https://ekmdewlyvvribdbiggup.supabase.co/rest/v1/waitlist_signups";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_B64KXLBA4HtF2FlCPsvvzA_OEGP1IqF";

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
      }
    });
  },
  { threshold: 0.16 }
);

revealItems.forEach((item) => observer.observe(item));

if (priceAnimation) {
  const priceObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.closest(".price-card")?.classList.add("is-price-animated");
        priceObserver.disconnect();
      });
    },
    { threshold: 0.55 }
  );
  priceObserver.observe(priceAnimation);
}

window.addEventListener("pointermove", (event) => {
  if (!glow) return;
  glow.style.setProperty("--x", `${event.clientX}px`);
  glow.style.setProperty("--y", `${event.clientY}px`);
});

document.querySelectorAll(".button, .header-cta, .header-try, .feature-card").forEach((item) => {
  item.addEventListener("pointermove", (event) => {
    const rect = item.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    item.style.setProperty("--mx", `${x}px`);
    item.style.setProperty("--my", `${y}px`);
  });
});

function openWaitlist(intent = "waitlist") {
  if (!waitlistModal) return;
  waitlistModal.hidden = false;
  document.body.style.overflow = "hidden";
  if (waitlistIntent) waitlistIntent.value = intent;
  waitlistModal.querySelector("input")?.focus();
}

function closeWaitlist() {
  if (!waitlistModal) return;
  waitlistModal.hidden = true;
  document.body.style.overflow = "";
}

document.querySelectorAll("[data-open-waitlist]").forEach((trigger) => {
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    openWaitlist(trigger.dataset.intent);
  });
});

document.querySelector("[data-close-waitlist]")?.addEventListener("click", closeWaitlist);

waitlistModal?.addEventListener("click", (event) => {
  if (event.target === waitlistModal) closeWaitlist();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && waitlistModal && !waitlistModal.hidden) {
    closeWaitlist();
  }
});

waitlistForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!formStatus) return;

  const submitButton = waitlistForm.querySelector('button[type="submit"]');
  const formData = new FormData(waitlistForm);
  const payload = {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim().toLowerCase(),
    social_handle: String(formData.get("social_handle") || "").trim() || null,
    intent: String(formData.get("intent") || "waitlist"),
    source_page: window.location.pathname || "/",
    user_agent: navigator.userAgent,
  };

  formStatus.className = "form-status";
  formStatus.textContent = "Saving your spot...";
  submitButton.disabled = true;

  try {
    const response = await fetch(SUPABASE_REST_URL, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 409) {
      waitlistForm.reset();
      formStatus.className = "form-status success";
      formStatus.textContent = "You're already on the list. We will email you when early access opens.";
      return;
    }

    if (!response.ok) {
      throw new Error("Waitlist table is not ready yet.");
    }

    waitlistForm.reset();
    formStatus.className = "form-status success";
    formStatus.textContent = "You're on the list. We will email you when early access opens.";
  } catch (error) {
    formStatus.className = "form-status error";
    formStatus.textContent =
      "Could not save yet. The form is ready, but Supabase needs the waitlist table setup first.";
  } finally {
    submitButton.disabled = false;
  }
});
