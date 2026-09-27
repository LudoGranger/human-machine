# Portrait assets

The picker uses the earlier generated pixel-portrait sheet in `site/assets/humans.png` and a matching extension in `site/assets/humans-obama-karpathy.png`. Sam Altman's generated likeness was replaced with the credited photograph below.

## Sam Altman photograph

`site/assets/sam-altman.jpg`: Sam Altman at TechCrunch Disrupt San Francisco 2019, photographed by Steve Jennings/Getty Images for TechCrunch; crop by James Tamim. [Source on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sam_Altman_CropEdit_James_Tamim.jpg), [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/). The downloaded 250px thumbnail is unchanged; the site displays it cropped and in grayscale using CSS. This asset is covered by its own license, not the repository's MIT license.

The extension was created with the built-in image generation tool, using the first sheet as a style reference. The PNG is retained unchanged, including its alpha channel; CSS positions each portrait within its own selector. These are stylized illustrations, not photographs or endorsements.

## Generation prompt

Use case: style-transfer. Asset: one two-cell portrait sprite sheet for a website's small human picker. Input image is a STYLE REFERENCE ONLY: retain its recognizable monochrome retro pixel-art / dithered portrait style. Create two NEW portraits, not any of the five people in the reference. Exactly two equally sized square cells horizontally: LEFT Barack Obama, RIGHT Andrej Karpathy. Each cell contains one recognizable straight-on head and upper shoulders, centered, matching face scale and head placement. Obama has his characteristic ears, close-cropped grey hair, warm neutral expression, dark simple suit. Karpathy has short dark hair, light facial stubble and a simple dark T-shirt. Heads occupy about 65 percent of each cell width, with 8 percent clear padding above. Tight upper-shoulder crops, no full torso. Black, grey and warm off-white pixels only. Genuinely transparent background and transparent space around the figures. No text, labels, borders, lines, crosshairs, frames, logos or decorative objects. Preserve crisp pixel steps, not smooth illustration. Overall landscape ratio 2:1.
