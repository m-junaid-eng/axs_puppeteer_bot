if (followAllEvents) {
      const scraped = [];
      
      // MANDATORY: Visit the team page first to establish session cookies
      console.log(`Establishing session at entry point: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
      
      // Capture the validated Referer for the Supabase links
      const listingReferer = page.url();

      await waitForManualCaptchaSolve(page, { interactive });