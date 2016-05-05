---
title: Exporting Plink Result to Excel File
date: 2011-08-26T13:01:03+00:00
author: Hoondy
layout: single
dsq_thread_id:
  - 4743097795
categories:
  - Genetics
  - How-To
  - Linux
tags:
  - EXCEL
  - GWAS
  - HAPLOVIEW
  - PLINK
---
Here&#8217;s a little tip using plink software. A lot of people might already know this and this might be &#8220;the way&#8221; to use this software, but I never knew about this until yesterday when I attended a workshop on &#8220;genome data analysis&#8221; hosted by Seoul National University medical school and they demonstrated to us how to utilize GUI version of plink software, namely gPLINK.

First, you need a GUI version of plink software running. If you&#8217;ve already downloaded plink software from [plink site](http://pngu.mgh.harvard.edu/~purcell/plink/download.shtml), you already have gPLINK jar file in your install directory.

Also, you need a version of Haploview from [Haploview site](http://www.broadinstitute.org/scientific-community/science/programs/medical-and-population-genetics/haploview/downloads). Download JAR version if you are running this under linux box.

If all set, launch gPLINK.jar from command line

**_java -jar /path-to-your-plink-directory/gPLINK.jar_**

When it&#8217;s successful, gPLINK launches in GUI mode like shown below.

[<img class="aligncenter size-full wp-image-137" title="gPLINK" src="http://hoondy.com/wp-content/uploads/2011/08/gPLINK.png" alt="" width="520" height="386" />](http://hoondy.com/wp-content/uploads/2011/08/gPLINK.png)

Go to **_Project_ > _Open_**, and open a directory containing ped and map files.

If folder contents are displayed in Folder viewer, go to **_Project_ > _Configure_** and set the path to Haploview and plink similar to shown below.

[<img class="aligncenter size-full wp-image-138" title="Configuration" src="http://hoondy.com/wp-content/uploads/2011/08/Configuration.png" alt="" width="520" height="386" />](http://hoondy.com/wp-content/uploads/2011/08/Configuration.png)

Now, let&#8217;s run a simple association test. Once the operation is done, expand Output files section and right click on *.assoc file, then select &#8220;**_Open in Haploview_**&#8220;.

[<img class="aligncenter size-full wp-image-139" title="Screenshot-gPLINK-2.050" src="http://hoondy.com/wp-content/uploads/2011/08/Screenshot-gPLINK-2.050.png" alt="" width="520" height="386" />](http://hoondy.com/wp-content/uploads/2011/08/Screenshot-gPLINK-2.050.png)

It will open up a dialog called &#8220;**_Open File in Haploview_**&#8220;. Just click_ **OK**_.

Now, the result is displayed in Haploview. You can use filters or create a Manhattan plot using menu on the bottom.

[<img class="aligncenter size-full wp-image-140" title="Screenshot-Haploview 4.2 -- association_test.assoc" src="http://hoondy.com/wp-content/uploads/2011/08/Screenshot-Haploview-4.2-association_test.assoc_.png" alt="" width="520" height="390" />](http://hoondy.com/wp-content/uploads/2011/08/Screenshot-Haploview-4.2-association_test.assoc_.png)

When you are done exploring and you want to export the result to an Excel file, you can go to **_File_ >_Export current tab to text_**.

[<img class="aligncenter size-full wp-image-141" title="Screenshot-Haploview 4.2 -- association_test.assoc-1" src="http://hoondy.com/wp-content/uploads/2011/08/Screenshot-Haploview-4.2-association_test.assoc-1.png" alt="" width="520" height="390" />](http://hoondy.com/wp-content/uploads/2011/08/Screenshot-Haploview-4.2-association_test.assoc-1.png)

Save the file as *.txt and you will find that this is a tab-delimited format, which is directly compatible with Microsoft Excel. Simply load file into Excel or right click on the file and use &#8220;**_Open with_**&#8221; option to select Microsoft Excel.

There are many advantages of using command line plink and using custom scripts and shell commands to modify outputs since it fulfills individual&#8217;s need. However, this is a good quick and dirty trick if you want to simply convert plink result to a much readable format. Enjoy!

-Hoondy

permalink: /2011/08/26/exporting-plink-result-to-excel-file/