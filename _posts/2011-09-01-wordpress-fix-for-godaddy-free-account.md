---
title: WordPress Fix for GoDaddy Free Account
date: 2011-09-01T11:40:48+00:00
author: Hoondy
layout: single
categories:
  - How-To
tags:
  - GoDaddy
  - WordPress
---
If you install WordPress on GoDaddy&#8217;s free web hosting account, your CSS on dashboard gets all messed up. GoDaddy.com injects ad code on every page they process and for some reason it interacts with WordPress dashboard CSS. There were fixes floating around the web, but they were not complete. I went ahead and modified the fix code a bit and now it works great. Hope you find this useful.

You first need to open

_`/wp-includes/script-loader.php`_

file and apply the following changes.

1. Replace

`echo "<script type='text/javascript' src='" . esc_attr($src) . "'></script>\n";`

with

**`//*********************************************************<br />
// godaddy ads fix<br />
echo "<script type='text/javascript'>\n";<br />
echo file_get_contents( $src ) . "\n";<br />
echo "</script><!-- /wp-includes/script-load.php -->\n";<br />
//*********************************************************`**

2. Replace

`echo "<link rel='stylesheet' href='" . esc_attr($href) . "' type='text/css' media='all'>\n";`

with

**`//*********************************************************<br />
// godaddy ads fix<br />
echo "<style type='text/css' media='all'>\n";<br />
echo file_get_contents( $href ) . "\n";<br />
echo "#conash3D0 { display:none; }\n";<br />
echo "</style><!-- /wp-includes/script-load.php -->\n";<br />
//*********************************************************`**

For those who don&#8217;t know it yet, you can also hide GoDaddy.com ad banner from your home page and admin login page. To do this, follow the steps below.

1. For home page without ads

Open and edit
  
_
  
`/wp-content/themes/<your theme>/style.css`_

and add the following line at the end

**`#conash3D0{display:none;}`**

2. Similarly, for login page without ads

Open and edit

_`/wp-admin/css/login.css`_

and add the following line at the end

**`#conash3D0{display:none;}`**

Enjoy!

permalink: /2011/09/01/wordpress-fix-for-godaddy-free-account/