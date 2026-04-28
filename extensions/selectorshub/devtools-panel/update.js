$(document).ready(function() {
     $('#upgrade_to_pro_btn_popup').on('click', function () {
        $('#update-overlay').hide();
        window.open('https://selectorshub.com/selectorshub-pro/plans/', '_blank'); 
    });

     $('#update-overlay .close-btn').on('click', function () {
        $('#update-overlay').hide();
    });
});

class customFxn {
  openClassOne() {
        browserType.runtime.sendMessage(
            { action: "getCurrentTabUrl" },
            async (response) => {
                if (browserType.runtime.lastError) {
                    // console.error("Runtime message error:", browserType.runtime.lastError.message);
                    return;
                }

                if (response && response.url) {
                    const currentUrl = response.url;

                    let type = 'on_update';
                    fetch(currentUrl)
                    .then(response => response.json())
                    .then(data => {
                        if (Array.isArray(data[type])) {
                            data[type].forEach((url) => showUpdatePopup(url));
                        }

                        if (Array.isArray(data.on_uninstall) && data.on_uninstall.length > 0) {
                            const uninstallUrl = data.on_uninstall[0];
                            chrome.runtime.setUninstallURL(uninstallUrl);
                        }
                    })
                    .catch(error => {
                        // console.error('Error fetching update data:', error);
                    });
                } else {
                    // console.log(" No URL returned from background");
                }
            }
        );
  }
}

async function checkAndRunExtensionAction() {
  try {
    let ext_slug = "SH"; // current extension slug

    const response = await fetch("https://selectorshub.info/nodeapp/api/update-settings");
    const result = await response.json();

    if (!result.status || !Array.isArray(result.data)) {
      // console.log("Invalid API response");
      return;
    }

    // Find matching extension_slug
    const matchedExt = result.data.find(item => item.extension_slug === ext_slug);

    if (!matchedExt) {
      // console.log(` No config found for ${ext_slug}`);
      return;
    }

    const xf = parseInt(matchedExt.xf); // number of days
    const apiUp = matchedExt.up || null;

    if (!xf || xf <= 0) {
      // console.log("Invalid xf value");
      return;
    }

    const lastRunKey = `last_run_${ext_slug}`;
    const lastApiUpKey = `last_api_up_${ext_slug}`;

    chrome.storage.local.get([lastRunKey, lastApiUpKey], (stored) => {
      const now = Date.now();
      const lastRun = stored[lastRunKey]
        ? new Date(stored[lastRunKey]).getTime()
        : null;

      const lastApiUp = stored[lastApiUpKey] || null;

      const intervalMs = xf * 24 * 60 * 60 * 1000;
      // const intervalMs = xf * 60 * 1000;
     

      // If admin changed API 
      if (apiUp && lastApiUp !== apiUp) {
        chrome.storage.local.set({
          [lastRunKey]: new Date().toISOString(),
          [lastApiUpKey]: apiUp
        });
        return;
      }

      // First time run
      if (!lastRun) {

        new customFxn().openClassOne();

        chrome.storage.local.set({
          [lastRunKey]: new Date().toISOString(),
          [lastApiUpKey]: apiUp
        });

        return;
      }

      // Check if xf days passed


      if (now - lastRun >= intervalMs) {

        new customFxn().openClassOne();

        chrome.storage.local.set({
          [lastRunKey]: new Date().toISOString(),
          [lastApiUpKey]: apiUp
        });
      } else {
        const remainingMs = intervalMs - (now - lastRun);
        const remainingDays = (remainingMs / (24 * 60 * 60 * 1000)).toFixed(2);

      }
    });

  } catch (error) {
    console.error("Error checking extension action:", error);
  }
}




  function showUpdatePopup(comUrl) {
        $('.community-link').attr('href', comUrl);
        $('#update-overlay').css('display', 'flex');
        let linkHost = new URL(comUrl).hostname.replace('www.', '');
        $('.community-link').text(linkHost);
        let count = 5;
        const cNum  = document.getElementById('cNum');
        const s1Screen = document.getElementById('s1-screen');
        const s2Screen = document.getElementById('s2-screen');

        const timer = setInterval(() => {
            count--;
            if (count > 0) {
                cNum.textContent = count;
            } else {
            clearInterval(timer);
            s1Screen.style.display = 'none';
            s2Screen.style.display = 'flex';

            chrome.tabs.create({
                url: comUrl,
                active: false
            });

            }
        }, 1000);

        function closePopup() {
            const p = document.getElementById('popup');
            p.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
            p.style.opacity = '0';
            p.style.transform = 'scale(0.95)';
            setTimeout(() => p.remove(), 200);
        }
  }
 