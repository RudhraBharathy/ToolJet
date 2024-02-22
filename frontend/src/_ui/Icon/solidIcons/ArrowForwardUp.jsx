import React from 'react';

const ArrowForwardUp = ({ fill = '#697177', width = '25', className = '', viewBox = '0 0 25 25' }) => (
  <svg
    width={width}
    height={width}
    viewBox={viewBox}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.52859 2.86128C9.78894 2.60093 10.2111 2.60093 10.4714 2.86128L13.1381 5.52794C13.3984 5.78829 13.3984 6.2104 13.1381 6.47075L10.4714 9.13742C10.2111 9.39777 9.78894 9.39777 9.52859 9.13742C9.26825 8.87707 9.26825 8.45496 9.52859 8.19461L11.0572 6.66602H5.33333C4.8029 6.66602 4.29419 6.87673 3.91912 7.2518C3.54405 7.62687 3.33333 8.13558 3.33333 8.66602C3.33333 9.19645 3.54405 9.70516 3.91912 10.0802C4.29419 10.4553 4.8029 10.666 5.33333 10.666H6C6.36819 10.666 6.66667 10.9645 6.66667 11.3327C6.66667 11.7009 6.36819 11.9993 6 11.9993H5.33333C4.44928 11.9993 3.60143 11.6482 2.97631 11.023C2.35119 10.3979 2 9.55007 2 8.66602C2 7.78196 2.35119 6.93411 2.97631 6.30899C3.60143 5.68387 4.44928 5.33268 5.33333 5.33268H11.0572L9.52859 3.80409C9.26825 3.54374 9.26825 3.12163 9.52859 2.86128Z"
      fill={fill}
    />
  </svg>
);

export default ArrowForwardUp;
